// The whole page on the host: the app's own runtime (createAppRuntime), its
// one built-in the stub plugin, against the app itself in the host process.
// Modules are loaded afresh per deck, so each test's page is a page of its
// own — the registry, the settings and the session table included.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject, vi } from "vitest";
import type { Pane, Workspace } from "../../domain/deck";
import type { Site } from "../../domain/lifecycle";
import type { Settings } from "../../domain/settings/types";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import type { Consent } from "../../ipc/generated/lifecycle/Consent";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import type { Preview } from "../../ipc/generated/lifecycle/Preview";
import type { PaneLaunch, PaneSessionState, PaneSpawnSpec, PtyManager } from "../../app/ptyManager";
import type { AppRuntime } from "../../app/runtime";
import { BRIDGE_ENV } from "../../app/spawnSpecs/plans";
import type { Host } from "./host";
import { STUB_AGENT, STUB_PLUGIN_ID, stubPlugin, type StubAgentControl } from "./stubPlugin";

/** One process the page started for a pane, as it asked the host for it. */
export interface Launch {
  pane: string;
  args: string[];
  /** The folder it runs in. */
  cwd: string | null;
}

/** An agent to add: its role, and the team it joins or the site it asks for
 * — or the agent server it runs on, for one that runs on another machine —
 * in the deck's first workspace unless another is named. */
export interface AgentAsk {
  role: string;
  team?: string;
  site?: Site;
  endpoint?: string;
  workspace?: WorkspaceRef;
}

/** One envelope a pane's reporter sends through the bridge: what it leaves
 * out is the plan's — the pane, its token — and, in the payload, the stub's
 * name and the sending process. */
export interface Envelope {
  type: string;
  paneId?: string;
  token?: string;
  payload?: Record<string, unknown>;
}

/** Who sends a report for a pane: its agent; a process the agent started in
 * its terminal; or a reporter outside every pane's terminal, which names no
 * process — a hook outliving its agent. */
export type Reporter = "agent" | "child" | "outside";

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
  /** Type a line into the pane's terminal — its process reads it. Bytes
   * written, as a paste or `pane.write` writes them: no key a person pressed. */
  type(paneId: string, line: string): void;
  /** A key a person presses in the pane: told as theirs, as the terminal view
   * tells it on xterm's key event (`reportPaneKey`), then written to the
   * process — in that order, xterm's own. */
  press(paneId: string, key: string): void;
  /** Everything the pane's terminals printed, in order. */
  output(paneId: string): string;
  /** Send one report for the pane through the bridge, and wait for the
   * bridge's answer — and, when the bridge took it, for the page to have
   * heard it. The answer's HTTP status. */
  report(paneId: string, envelope: Envelope, from?: Reporter): Promise<number>;
  /** Every process the page started for the pane, in order. */
  launches(paneId: string): Launch[];
  /** Whether the page still holds a launch plan for the pane. */
  holdsPlan(paneId: string): boolean;
  /** The deck's first workspace, as the page holds it now. */
  workspace(): Workspace;
  /** A pane of any workspace, as the page holds it now. */
  pane(paneId: string): Pane;
  /** The deck's first workspace, made at the test's work folder, its
   * worktrees in the test's own, if there is none yet. */
  workspaceUp(): Promise<WorkspaceRef>;
  /** Another workspace, made at `cwd` — the deck opens it as it lands. */
  anotherWorkspace(name: string, cwd: string): Promise<WorkspaceRef>;
  /** A stub agent asked for — accepted, not yet up. */
  addAgent(ask: AgentAsk): Promise<string>;
  /** A team with nobody on it, made at `site` in the first workspace, or
   * in the one named. */
  teamUp(name: string, site: Site, workspace?: WorkspaceRef): Promise<string>;
  /** The intents the page asked of the machine, in order, as they went. */
  intents(): Intent[];
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
  /** Change settings as the settings page does. */
  updateSettings(patch: Partial<Settings>): void;
  /** A stub agent run outside the deck, holding `sessionId` as a CLI's own
   * interactive run would — in its registry while it runs; ended by the
   * answer. */
  runOutside(sessionId: string): Promise<() => void>;
  /** A session registry of the page's own kind, built afresh over the app's
   * sessions machine — for a test of the registry itself, apart from the
   * deck's panes. */
  sessionRegistry(): PtyManager;
  /** A launch the machine leases now: one process the stub plugin runs in
   * the first workspace, held by no pane and in no folder of ours. */
  leaseLaunch(): Promise<PaneLaunch>;
  /** The stub program as a plain process, in no folder: it says `stub:
   * ready` at start — or nothing, `silent` — then what its typed cues ask. */
  stubProcess(silent?: boolean): PaneSpawnSpec;
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

/** An intent as the page sent it: an object with its kind — the wire's own
 * type, read back off the tape. */
function isIntent(value: unknown): value is Intent {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "kind") === "string";
}

/** A process the page asked the host for: its launch, the channel its
 * terminal speaks on, and the bridge its plan armed, as its env holds it. */
interface Opened extends Launch {
  channel: number | null;
  armed: string | null;
}

/** The bridge's answer to the post `cue` named, by what the stub printed —
 * null while it is not in. */
function answerTo(said: string, cue: string): number | null {
  const answered = new RegExp(`stub: posted \\S+ (\\d{3}) ${cue}\\b`).exec(said);
  return answered ? Number(answered[1]) : null;
}

function openedOf(line: string): Opened | null {
  const said: unknown = JSON.parse(line);
  if (typeof said !== "object" || said === null || Reflect.get(said, "cmd") !== "pty_open") return null;
  const args: unknown = Reflect.get(said, "args");
  if (typeof args !== "object" || args === null) return null;
  const owner: unknown = Reflect.get(args, "owner");
  const spec: unknown = Reflect.get(args, "spec");
  const events: unknown = Reflect.get(args, "onEvent");
  const pane = typeof owner === "object" && owner !== null ? Reflect.get(owner, "pane") : null;
  const argv = typeof spec === "object" && spec !== null ? Reflect.get(spec, "args") : null;
  const cwd = typeof spec === "object" && spec !== null ? Reflect.get(spec, "cwd") : null;
  const env: unknown = typeof spec === "object" && spec !== null ? Reflect.get(spec, "env") : null;
  if (typeof pane !== "string" || !Array.isArray(argv)) return null;
  const channel = typeof events === "string" ? Number(events.replace("__CHANNEL__:", "")) : NaN;
  return {
    pane,
    args: argv.map(String),
    cwd: typeof cwd === "string" ? cwd : null,
    channel: Number.isInteger(channel) ? channel : null,
    armed: bridgeIn(env),
  };
}

/** The bridge an environment carries, as a plan arms it. */
function bridgeIn(env: unknown): string | null {
  const armed: unknown = Array.isArray(env) ? env.find((pair) => Array.isArray(pair) && pair[0] === BRIDGE_ENV) : undefined;
  return Array.isArray(armed) && typeof armed[1] === "string" ? armed[1] : null;
}

/** The terminal output one channel message carries, if it carries any. */
function outputOf(line: string, channel: number): string {
  if (!line.startsWith(`{"channel":${channel},`)) return "";
  const said: unknown = JSON.parse(line);
  const message = typeof said === "object" && said !== null ? Reflect.get(said, "message") : null;
  const data = typeof message === "object" && message !== null ? Reflect.get(message, "data") : null;
  return typeof data === "string" ? Buffer.from(data, "base64").toString("utf8") : "";
}

/** The deck as the app saved it in `host`'s home, or "" before it has. */
export function deckOnDisk(host: Host): string {
  const file = join(host.home, "deck.json");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** While the app is down, rewrite what the deck on disk says of one pane —
 * what the next launch boots from. */
function rewritePaneOnDisk(host: Host, said: string, now: string): void {
  const saved = deckOnDisk(host);
  if (!saved.includes(said)) throw new Error(`deck.json does not say ${said}`);
  writeFileSync(join(host.home, "deck.json"), saved.split(said).join(now));
}

/** While the app is down, the pane's agent loses its plugin: the deck names
 * an agent nothing provides. */
export function retireOnDisk(host: Host, paneId: string): void {
  rewritePaneOnDisk(host, `"id":"${paneId}","agentType":"${STUB_AGENT}"`, `"id":"${paneId}","agentType":"retired-cli"`);
}

/** While the app is down, the deck records a conversation for the pane that
 * no process of it bound. */
export function bindOnDisk(host: Host, paneId: string, sessionId: string): void {
  rewritePaneOnDisk(host, `"id":"${paneId}",`, `"id":"${paneId}","session":{"id":"${sessionId}","boundAt":"2026-01-01T00:00:00.000Z"},`);
}

/** Start a deck, set it up, wait until the deck on disk says `saved` of
 * what the setup made, then quit the app and launch it again on the same
 * home — `meanwhile` run while it is down: what the next launch boots from.
 * What the setup made. */
export async function quitAfter<T>(
  host: Host,
  setUp: (deck: Deck) => Promise<T>,
  saved: (onDisk: string, made: T) => boolean,
  meanwhile?: (made: T) => void,
): Promise<T> {
  const deck = await startDeck(host);
  let made: T;
  try {
    made = await setUp(deck);
    const kept = made;
    await host.until("the deck is on disk as it was set up", () => saved(deckOnDisk(host), kept), 15_000);
  } finally {
    deck.dispose();
  }
  const kept = made;
  await host.relaunch("quit", meanwhile && (() => meanwhile(kept)));
  return made;
}

/** How a deck starts: by default it is up once the machine has opened and
 * its plugins are active; a test of the page before either asks for it at
 * once. */
export interface DeckStart {
  waitForOpen?: boolean;
  waitForPlugins?: boolean;
}

/** Start the page's runtime on `host`, and wait for the machine to open and
 * the stub plugin to be active — its stub agent told `told` from the first
 * plan on (a launch's boot resumes are planned before this answers). */
export async function startDeck(host: Host, told: Partial<StubAgentControl> = {}, { waitForOpen = true, waitForPlugins = true }: DeckStart = {}): Promise<Deck> {
  vi.resetModules();
  const { createAppRuntime } = await import("../../app/runtime");
  const { createCommandRegistry } = await import("../../domain/commands/registry");
  const sessions = await import("../../app/ptyManager");
  const { askLease, previewIntent } = await import("../../ipc/lifecycle");
  const { openSession } = await import("../../ipc/session");
  const { pluginLaunch } = await import("../../app/plugins/pluginSessions");
  const { reportPaneKey } = await import("../../app/paneKeys");
  const { peekPaneSpawnSpec } = await import("../../app/spawnSpecs");
  const settings = await import("../../app/settingsManager");
  const stub: StubAgentControl = {
    plans: [],
    rejectResumes: 0,
    rejectForks: false,
    resumePlanFails: null,
    deaf: false,
    unbound: false,
    resumes: true,
    storeDir: join(host.home, "stub-store"),
    sessions: null,
    spawnPlanFails: null,
    programGone: false,
    voiceless: false,
    turnStartWord: "turn-start",
    keepsStore: true,
    tailed: true,
    limitsRead: null,
    sweep: null,
    lookups: 0,
    lookupHeld: null,
    liveRegistry: "files",
    liveDir: join(host.home, "stub-live"),
    ...told,
  };
  const runtime = createAppRuntime(undefined, createCommandRegistry(), () => Promise.resolve([stubPlugin(stub)]));
  runtime.start();
  if (waitForOpen) await host.until("the machine opened its barrier", () => heardOpen(host), 15_000);
  // A page is up once its plugins are: a plan asked before the stub's
  // activation finds no agent to build it.
  if (waitForPlugins) {
    await host.until("the stub plugin is active", () => runtime.plugins.pluginRegistries.agents.list().some(({ entry }) => entry.id === STUB_AGENT), 15_000);
  }

  /** The stub agents run outside the deck, ended with it. */
  const outside: ChildProcess[] = [];
  const workspace = (): Workspace => {
    const ws = runtime.deckStore.getSnapshot().workspaces[0];
    if (!ws) throw new Error("no workspace on the deck");
    return ws;
  };
  const pane = (paneId: string): Pane => {
    const found = runtime.deckStore
      .getSnapshot()
      .workspaces.flatMap((ws) => ws.panes)
      .find((candidate) => candidate.id === paneId);
    if (!found) throw new Error(`no pane ${paneId} on the deck`);
    return found;
  };
  const opened = (paneId: string): Opened[] =>
    host.tape.flatMap(({ way, line }) => {
      const open = way === "page →" ? openedOf(line) : null;
      return open && open.pane === paneId ? [open] : [];
    });
  const launches = (paneId: string): Launch[] => opened(paneId).map(({ pane, args, cwd }) => ({ pane, args, cwd }));
  const output = (paneId: string): string => {
    const channels = opened(paneId).flatMap(({ channel }) => (channel === null ? [] : [channel]));
    return host.tape.map(({ way, line }) => (way === "← host" ? channels.map((channel) => outputOf(line, channel)).join("") : "")).join("");
  };
  /** Cue a stub in the pane's terminal — its agent, or the process the
   * agent started — to send the envelope; the bridge's answer. */
  async function postInTerminal(paneId: string, envelope: Envelope, from: "agent" | "child", cue: string): Promise<number> {
    sessions.writePane(paneId, `${from === "child" ? "child " : ""}post ${JSON.stringify({ ...envelope, cue })}\r`);
    let answer: number | null = null;
    await host.until(`${paneId}'s report ${cue} is answered`, () => (answer = answerTo(output(paneId), cue)) !== null);
    return answer ?? 0;
  }
  /** A stub run outside every pane's terminal, armed with the pane's
   * bridge, sends the envelope naming no process — its reporter blank, as
   * a shell hook that could not tell its process fills it; the bridge's
   * answer. The bridge is the one its last process was opened with — or,
   * while that open has not gone out, the one its plan armed. */
  async function postOutside(paneId: string, envelope: Envelope, cue: string): Promise<number> {
    const armed = opened(paneId).pop()?.armed ?? bridgeIn(peekPaneSpawnSpec(paneId)?.env);
    if (!armed) throw new Error(`no bridge armed for ${paneId}`);
    const reporter = spawn(process.execPath, [inject("stubAgent"), "--child"], { env: { ...process.env, [BRIDGE_ENV]: armed }, stdio: ["pipe", "pipe", "ignore"] });
    outside.push(reporter);
    let said = "";
    reporter.stdout.on("data", (chunk) => (said += String(chunk)));
    reporter.stdin.write(`post ${JSON.stringify({ ...envelope, payload: { reporter: "", ...envelope.payload }, cue })}\n`);
    let answer: number | null = null;
    await host.until(`the outside report ${cue} for ${paneId} is answered`, () => (answer = answerTo(said, cue)) !== null);
    reporter.kill();
    return answer ?? 0;
  }
  /** Reports sent so far, each named by its own cue. */
  let reports = 0;
  async function report(paneId: string, envelope: Envelope, from: Reporter = "agent"): Promise<number> {
    const mark = host.tape.length;
    const cue = `r${++reports}`;
    const answer = from === "outside" ? await postOutside(paneId, envelope, cue) : await postInTerminal(paneId, envelope, from, cue);
    // The bridge emits what it takes before it answers; the page hears it
    // on the pipe.
    if (answer === 204) {
      const about = `"paneId":"${envelope.paneId ?? paneId}"`;
      await host.until(`the page heard ${envelope.type} for ${paneId}`, () =>
        host.tape.slice(mark).some(({ way, line }) => way === "← host" && line.startsWith('{"event":') && line.includes(about)));
    }
    return answer;
  }
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
  async function addAgent({ endpoint, workspace: into, ...ask }: AgentAsk): Promise<string> {
    const draft = { agentType: STUB_AGENT, ...(endpoint !== undefined && { location: { kind: "remote" as const, endpoint } }) };
    const added = await runtime.orchestrator.createPane({ workspace: into ?? (await workspaceUp()), pane: draft, ...ask });
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
    holdsPlan: (paneId) => peekPaneSpawnSpec(paneId) !== undefined,
    press(paneId, key) {
      reportPaneKey(paneId, key);
      sessions.writePane(paneId, key);
    },
    output,
    report,
    launches,
    workspace,
    pane,
    workspaceUp,
    async anotherWorkspace(name, cwd) {
      const made = await runtime.orchestrator.createWorkspace({ name, cwd, worktreeBaseDir: null });
      const id = made.kind === "accepted" ? made.minted.workspace : null;
      if (!id) throw new Error(`no workspace: ${JSON.stringify(made)}`);
      await host.until(`${name} is on the deck`, () => runtime.deckStore.getSnapshot().workspaces.some((ws) => ws.id === id));
      const ws = runtime.deckStore.getSnapshot().workspaces.find((candidate) => candidate.id === id);
      if (!ws) throw new Error(`${name} left the deck`);
      return { id, instance: ws.instance };
    },
    addAgent,
    async teamUp(name, site, into) {
      const made = await runtime.orchestrator.createTeam({ workspace: into ?? (await workspaceUp()), name, site });
      if (made.kind !== "accepted" || !made.minted.team) throw new Error(`no team: ${JSON.stringify(made)}`);
      const team = made.minted.team;
      const teams = () => runtime.deckStore.getSnapshot().workspaces.flatMap((ws) => ws.teams ?? []);
      await host.until(`${team} is on the deck`, () => teams().some((candidate) => candidate.id === team));
      return team;
    },
    intents: () =>
      host.tape.flatMap(({ way, line }) => {
        if (way !== "page →" || !line.includes('"cmd":"lifecycle_intent"')) return [];
        const said: unknown = JSON.parse(line);
        const args = typeof said === "object" && said !== null ? Reflect.get(said, "args") : null;
        const intent: unknown = typeof args === "object" && args !== null ? Reflect.get(args, "intent") : null;
        return isIntent(intent) ? [intent] : [];
      }),
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
    async runOutside(sessionId) {
      const child = spawn(process.execPath, [inject("stubAgent"), "--resume", sessionId], {
        env: { ...process.env, KEEPDECK_STUB_LIVE: stub.liveDir },
        stdio: ["pipe", "ignore", "ignore"],
      });
      outside.push(child);
      await host.until(`${sessionId} runs outside`, () => existsSync(join(stub.liveDir, sessionId)));
      return () => child.kill("SIGKILL");
    },
    sessionRegistry: () => sessions.createPtyManager(openSession),
    async leaseLaunch() {
      // Asked as the app asks for a plugin's own process, through its port.
      const ask = pluginLaunch(STUB_PLUGIN_ID, workspace().id, null);
      const reply = await askLease(ask);
      if (reply.kind !== "answered" || reply.answer.kind !== "leased") throw new Error(`no launch lease: ${JSON.stringify(reply)}`);
      return { permit: reply.answer.permit, owner: ask.owner };
    },
    stubProcess: (silent = false) => ({
      command: process.execPath,
      // A child of an agent says nothing of its own and takes its cues as typed.
      args: [inject("stubAgent"), silent ? "--child" : "--unbound"],
      // A plugin's process runs in no folder of ours: its lease names none.
      cwd: null,
      cols: 80,
      rows: 24,
    }),
    updateSettings: (patch) => settings.updateSettings(patch),
    gitRepo() {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: host.work, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("-c", "user.name=kd", "-c", "user.email=kd@localhost", "commit", "-q", "--allow-empty", "-m", "init");
    },
    dispose() {
      for (const child of outside.splice(0)) child.kill("SIGKILL");
      runtime.dispose();
    },
  };
}
