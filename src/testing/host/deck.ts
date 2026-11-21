// The whole page on the host: the app's own runtime (createAppRuntime), its
// one built-in the stub plugin, against the app itself in the host process.
// Modules are loaded afresh per deck, so each test's page is a page of its
// own — the registry, the settings and the session table included.
import { execFileSync } from "node:child_process";
import { vi } from "vitest";
import type { Pane, Workspace } from "../../domain/deck";
import type { Site } from "../../domain/lifecycle";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import type { Consent } from "../../ipc/generated/lifecycle/Consent";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import type { Preview } from "../../ipc/generated/lifecycle/Preview";
import type { PaneSessionState } from "../../app/ptyManager";
import type { AppRuntime } from "../../app/runtime";
import type { Host } from "./host";
import { STUB_AGENT, stubPlugin, type StubAgentControl } from "./stubPlugin";

/** One process the page started for a pane, as it asked the host for it. */
export interface Launch {
  pane: string;
  args: string[];
  /** The folder it runs in. */
  cwd: string | null;
}

/** An agent to add: its role, and the team it joins or the site it asks for. */
export interface AgentAsk {
  role: string;
  team?: string;
  site?: Site;
}

export interface Deck {
  runtime: AppRuntime;
  /** What the stub agent's next plans do. */
  stub: StubAgentControl;
  /** The page's own state of the pane's process slot. */
  slot(paneId: string): PaneSessionState["kind"];
  /** The pane's phase as the page last heard the machine say it — what the
   * page reads to tell a suspend still under way from one that is over. */
  phase(paneId: string): string | null;
  /** Whether the machine, as the page last heard it, has no operation's
   * command still out to the page. */
  settled(): boolean;
  /** The first workspace's phase as the page last heard the machine say it. */
  workspacePhase(): string | null;
  /** Type a line into the pane's terminal — its process reads it. */
  type(paneId: string, line: string): void;
  /** Every process the page started for the pane, in order. */
  launches(paneId: string): Launch[];
  /** The deck's first workspace, as the page holds it now. */
  workspace(): Workspace;
  /** A pane of the first workspace, as the page holds it now. */
  pane(paneId: string): Pane;
  /** The deck's first workspace, made at the test's work folder, its
   * worktrees in the test's own, if there is none yet. */
  workspaceUp(): Promise<WorkspaceRef>;
  /** A stub agent asked for in the first workspace — accepted, not yet up. */
  addAgent(ask: AgentAsk): Promise<string>;
  /** Wait for the pane to be up, its process live and its conversation
   * bound; its conversation. */
  upAndBound(paneId: string): Promise<string>;
  /** A workspace at the test's work folder with one stub agent in it, up
   * and bound to its conversation. */
  agentUp(): Promise<{ ws: WorkspaceRef; paneId: string; session: string }>;
  /** Another stub agent on `teamId`, up and bound. */
  memberUp(teamId: string, role: string): Promise<string>;
  /** What the machine previews of `intent`, as a dialog asks for it. */
  preview(intent: Intent): Promise<Preview>;
  /** The consent a close's dialog would send: what the machine's preview
   * says it ends — and, when the person ticks them, the folders it offers
   * to delete. */
  consentFor(intent: Intent, deleting?: boolean): Promise<Consent>;
  /** Make the test's work folder a git repository with one commit. */
  gitRepo(): void;
  dispose(): void;
}

/** Whether the page has heard the machine of the app's current launch open
 * its barrier: a lifecycle snapshot that says so, on the pipe the page reads
 * it from. */
function heardOpen(host: Host): boolean {
  return host.tape.slice(host.launchedAt()).some(({ way, line }) => way === "← host" && line.includes('"open":true'));
}

/** The machine's last snapshot the page heard in the app's current launch,
 * from the lifecycle channel. */
function lastSnapshot(host: Host): object | null {
  for (let at = host.tape.length - 1; at >= host.launchedAt(); at -= 1) {
    const { way, line } = host.tape[at];
    if (way !== "← host" || !line.includes('"kind":"snapshot"')) continue;
    const said: unknown = JSON.parse(line);
    const message = typeof said === "object" && said !== null ? Reflect.get(said, "message") : null;
    const versioned = typeof message === "object" && message !== null ? Reflect.get(message, "versioned") : null;
    const snapshot = typeof versioned === "object" && versioned !== null ? Reflect.get(versioned, "snapshot") : null;
    if (typeof snapshot === "object" && snapshot !== null) return snapshot;
  }
  return null;
}

function launchOf(line: string): Launch | null {
  const said: unknown = JSON.parse(line);
  if (typeof said !== "object" || said === null || Reflect.get(said, "cmd") !== "pty_open") return null;
  const args: unknown = Reflect.get(said, "args");
  if (typeof args !== "object" || args === null) return null;
  const owner: unknown = Reflect.get(args, "owner");
  const spec: unknown = Reflect.get(args, "spec");
  const pane = typeof owner === "object" && owner !== null ? Reflect.get(owner, "pane") : null;
  const argv = typeof spec === "object" && spec !== null ? Reflect.get(spec, "args") : null;
  const cwd = typeof spec === "object" && spec !== null ? Reflect.get(spec, "cwd") : null;
  if (typeof pane !== "string" || !Array.isArray(argv)) return null;
  return { pane, args: argv.map(String), cwd: typeof cwd === "string" ? cwd : null };
}

/** Start the page's runtime on `host`, and wait for the machine to open. */
export async function startDeck(host: Host): Promise<Deck> {
  vi.resetModules();
  const { createAppRuntime } = await import("../../app/runtime");
  const { createCommandRegistry } = await import("../../domain/commands/registry");
  const sessions = await import("../../app/ptyManager");
  const { previewIntent } = await import("../../ipc/lifecycle");
  const stub: StubAgentControl = { rejectResumes: false, rejectForks: false, deaf: false };
  const runtime = createAppRuntime(undefined, createCommandRegistry(), () => Promise.resolve([stubPlugin(stub)]));
  runtime.start();
  await host.until("the machine opened its barrier", () => heardOpen(host), 15_000);

  const workspace = (): Workspace => {
    const ws = runtime.deckStore.getSnapshot().workspaces[0];
    if (!ws) throw new Error("no workspace on the deck");
    return ws;
  };
  const pane = (paneId: string): Pane => {
    const found = workspace().panes.find((candidate) => candidate.id === paneId);
    if (!found) throw new Error(`no pane ${paneId} on the deck`);
    return found;
  };
  const launches = (paneId: string): Launch[] =>
    host.tape.flatMap(({ way, line }) => {
      const launch = way === "page →" ? launchOf(line) : null;
      return launch && launch.pane === paneId ? [launch] : [];
    });
  /** The pane is up, its process live, and its conversation bound. */
  async function upAndBound(paneId: string): Promise<string> {
    await host.until(`${paneId} is up and bound`, () => sessions.paneSessionState(paneId).kind === "live" && pane(paneId).session !== undefined, 15_000);
    return pane(paneId).session?.id ?? "";
  }
  async function workspaceUp(): Promise<WorkspaceRef> {
    if (runtime.deckStore.getSnapshot().workspaces.length === 0) {
      const made = await runtime.orchestrator.createWorkspace({ name: "ws", cwd: host.work, worktreeBaseDir: host.trees });
      if (made.kind !== "accepted") throw new Error(`no workspace: ${JSON.stringify(made)}`);
    }
    const ws = workspace();
    return { id: ws.id, instance: ws.instance };
  }
  async function addAgent(ask: AgentAsk): Promise<string> {
    const added = await runtime.orchestrator.createPane({ workspace: await workspaceUp(), pane: { agentType: STUB_AGENT }, ...ask });
    if (added.kind !== "accepted") throw new Error(`no agent: ${JSON.stringify(added)}`);
    const paneId = added.minted.panes[0];
    if (!paneId) throw new Error("the machine minted no pane");
    return paneId;
  }

  return {
    runtime,
    stub,
    slot: (paneId) => sessions.paneSessionState(paneId).kind,
    phase(paneId) {
      const panes = lastSnapshot(host);
      const phases = panes ? Reflect.get(panes, "panes") : null;
      const phase = typeof phases === "object" && phases !== null ? Reflect.get(phases, paneId) : null;
      return typeof phase === "string" ? phase : null;
    },
    settled() {
      const snapshot = lastSnapshot(host);
      const commands = snapshot ? Reflect.get(snapshot, "commands") : null;
      return Array.isArray(commands) && commands.length === 0;
    },
    workspacePhase() {
      const snapshot = lastSnapshot(host);
      const phases = snapshot ? Reflect.get(snapshot, "workspaces") : null;
      const phase = typeof phases === "object" && phases !== null ? Reflect.get(phases, workspace().id) : null;
      return typeof phase === "string" ? phase : null;
    },
    type: (paneId, line) => sessions.writePane(paneId, `${line}\r`),
    launches,
    workspace,
    pane,
    workspaceUp,
    addAgent,
    upAndBound,
    async agentUp() {
      const ws = await workspaceUp();
      const paneId = await addAgent({ role: "lead" });
      return { ws, paneId, session: await upAndBound(paneId) };
    },
    async memberUp(teamId, role) {
      const paneId = await addAgent({ role, team: teamId });
      await upAndBound(paneId);
      return paneId;
    },
    preview: (intent) => previewIntent(intent),
    async consentFor(intent, deleting = false) {
      const preview = await previewIntent(intent);
      return { stops: preview.stops, folders: deleting ? preview.folders : [], tickets: deleting ? preview.creations : [] };
    },
    gitRepo() {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: host.work, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("-c", "user.name=kd", "-c", "user.email=kd@localhost", "commit", "-q", "--allow-empty", "-m", "init");
    },
    dispose: () => runtime.dispose(),
  };
}
