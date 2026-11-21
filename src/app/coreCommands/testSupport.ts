/**
 * The host the core commands are registered against: the mocked IPC they
 * reach, a deck stub that records what they did, and a fresh registry.
 *
 * Every suite must import THIS module before anything else that reaches the
 * mocked IPC. The doubles below register when this module evaluates, and
 * `../coreCommands` — which every suite also wants — pulls the real
 * `ipc/worktree` in if it is imported first.
 */
import { vi } from "vitest";
import type { AgentInfo } from "../../domain/agents";
import { createCommandRegistry } from "../../domain/commands";
import {
  nextAutoTeamName,
  paneId,
  sameDirectory,
  teamFull,
  teamIdsOf,
  teamNameTaken,
  updateWorkspace,
  type AgentReach,
  type TeamLocation,
  type Workspace,
} from "../../domain/deck";
import { testTeamId } from "../../domain/deck/teams/testSupport";
import { roleRefused, type IntentOutcome, type Minted, type OwnerRefusal, type ResumeOutcome, type Site, type SuspendResult } from "../../domain/lifecycle";
import { admitRole } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { CreatePaneRequest, CreateTeamRequest } from "../agentOrchestrator";
import { fakeMcpLibrary } from "../mcpLibrary.fake";
import { fakeSkillsLibrary } from "../skillsLibrary.fake";
import { registerCoreCommands, type CommandDeck, type CoreCommandDeps } from ".";

const GONE: IntentOutcome = { kind: "refused", refusal: { kind: "notFound" } };
const rejected = (why: OwnerRefusal): IntentOutcome => ({ kind: "refused", refusal: { kind: "rejected", why } });

/** Where the deck draws a team the machine made at `site`: attached to the
 * root or a folder that exists, or a worktree card heading for its place —
 * the one typed, else the workspace's first. */
function locationAt(ws: Workspace, site: Site): TeamLocation {
  switch (site.kind) {
    case "root":
      return { kind: "attached", cwd: ws.cwd };
    case "existing":
      return { kind: "attached", cwd: site.cwd };
    case "new":
      return {
        kind: "provisioning",
        intent: {
          repo: ws.cwd,
          path: site.place?.path ?? `${ws.worktreeBaseDir ?? "/wt"}/kd-${ws.name}-1`,
          branch: site.place?.branch ?? `kd/${ws.name}/1`,
          index: 0,
        },
      };
  }
}

export const HOST = { kind: "host" } as const;

// Repo inspection is per-test switchable; probes report every path free.
const hoistedRepoMode = vi.hoisted(() => ({
  isRepo: false,
  inspect: null as null | (() => Promise<{
    isRepo: boolean;
    head: string;
    branch: string;
  }>),
}));
export const repoMode = hoistedRepoMode;
vi.mock("../../ipc/worktree", () => ({
  inspectRepo: () =>
    hoistedRepoMode.inspect?.() ??
    Promise.resolve({
      isRepo: hoistedRepoMode.isRepo,
      head: "abc",
      branch: "main",
    }),
  probeWorktree: async () => ({
    exists: false,
    isWorktree: false,
    empty: false,
    branch: null,
  }),
}));

const hoistedSettingsState = vi.hoisted(() => ({
  current: null as { defaultYolo?: boolean; defaultAgent?: string | null } | null,
}));
export const settingsState = hoistedSettingsState;
vi.mock("../settingsManager", () => ({
  getSettings: () => hoistedSettingsState.current,
}));

export const AGENTS: AgentInfo[] = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    features: [
      { id: "session.new", label: "New sessions" },
      { id: "execution.yolo", label: "YOLO mode" },
    ],
    installed: true,
    path: "/c",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    features: [{ id: "session.new", label: "New sessions" }],
    installed: true,
    path: "/x",
  },
];

export const workspace = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

/** Two workspaces, ws-1 active and ws-2 not — what every case about addressing
 * one workspace rather than another needs. Beside `workspace` because three
 * suites had each arranged it inline. */
export const twoWorkspaces = (): Workspace[] => [
  workspace({}),
  workspace({ id: "ws-2", name: "site" }),
];

/** A deck stub: the live workspaces array + recording actions. An edit goes
 * through the domain's own transition, as the real action does. */
function fakeDeck(workspaces: Workspace[]) {
  const deck = {
    workspaces,
    activeId: workspaces[0]?.id ?? "",
    viewOf: vi.fn<CommandDeck["viewOf"]>(() => ({})),
    selectWorkspace: vi.fn<CommandDeck["selectWorkspace"]>(),
    selectPane: vi.fn<CommandDeck["selectPane"]>(),
    renameTeam: vi.fn<CommandDeck["renameTeam"]>(),
  } satisfies CommandDeck;
  return deck;
}

/** The workspace edit door over the deck stub: the domain's own transition,
 * as the real door makes it. */
function editDoor(deck: { workspaces: Workspace[] }) {
  return vi.fn<CoreCommandDeps["updateWorkspace"]>((ref, patch) => {
    const result = updateWorkspace(deck.workspaces, ref, patch);
    if (result.ok) deck.workspaces = result.workspaces;
    return result;
  });
}

export function setup(workspaces: Workspace[]) {
  const registry = createCommandRegistry();
  const deck = fakeDeck(workspaces);
  const updateWorkspace = editDoor(deck);
  const requestCloseAgent = vi.fn();
  const activatePane = vi.fn((wsId: string, paneId: string) => {
    deck.selectWorkspace(wsId);
    deck.selectPane(wsId, paneId);
  });
  const activateTeam = vi.fn();
  const requestDisbandTeam = vi.fn();
  const retryProvisioning = vi.fn(
    async (_wsId: string, _teamId: string): Promise<IntentOutcome> => ({ kind: "accepted", op: 0, minted: { workspace: null, team: null, panes: [] } }),
  );
  const suspendAgent = vi.fn(async (_wsId: string, _paneId: string): Promise<SuspendResult> => ({ kind: "suspending" }));
  const resumeAgent = vi.fn(async (_wsId: string, _paneId: string): Promise<ResumeOutcome> => ({ kind: "resuming" }));
  const lifetime = (ref: CreatePaneRequest["workspace"]) =>
    workspaces.find((candidate) => candidate.id === ref.id && candidate.instance === ref.instance);
  let ops = 0;
  /** What the machine answers for what it made: the next op, and its ids. */
  const accepted = (minted: Partial<Minted>): IntentOutcome => {
    ops += 1;
    return { kind: "accepted", op: ops, minted: { workspace: null, team: null, panes: [], ...minted } };
  };
  /** The next pane id no workspace holds. */
  const nextPaneId = () =>
    paneId(1 + Math.max(0, ...workspaces.flatMap((ws) => ws.panes.map((pane) => Number(/^pane-(\d+)$/.exec(pane.id)?.[1] ?? 0)))));
  // The landing, as a double of the machine and the deck owner together: a
  // request naming a team joins it (a team not here refuses), any other
  // request makes a team at the site it asked for (the root when it asked
  // for none) under the name it gave, and the pane joins under the role it
  // asked for — refused by the deck's own cap and role rule, in their own
  // words, before anything is written. The ids are the test's predictable
  // ones where production's are the machine's.
  const createPane = vi.fn(async ({ workspace: ref, pane, site, team, role, teamName }: CreatePaneRequest): Promise<IntentOutcome> => {
    const ws = lifetime(ref);
    if (!ws) return GONE;
    if (team !== undefined && !ws.teams?.some((candidate) => candidate.id === team)) return rejected({ kind: "gone", what: "team" });
    const teamId = team ?? testTeamId(teamIdsOf(workspaces));
    const fresh = team === undefined ? { id: teamId, name: teamName ?? nextAutoTeamName(ws), location: locationAt(ws, site ?? { kind: "root" }) } : null;
    const landing: Workspace = fresh ? { ...ws, teams: [...(ws.teams ?? []), fresh] } : ws;
    if (teamFull(landing, teamId)) return rejected({ kind: "teamFull" });
    // The one rule the real deck owner asks, asked here too rather than
    // re-spelled: a hand-rolled "taken → suggest" lived here once and
    // answered "created" for a role the landing would refuse.
    const admitted = admitRole(landing, teamId, role);
    if (!admitted.ok) return rejected(roleRefused(admitted));
    const id = nextPaneId();
    ws.teams = landing.teams;
    ws.panes.push({ id, ...pane, team: { teamId, role: admitted.role } });
    return accepted({ team: fresh?.id ?? null, panes: [id] });
  });
  /**
   * The team door, as a double: a team made EMPTY at the site it asked for,
   * under the name it gave ("Team N" for none) — refused, as the deck
   * refuses it, under a name a team here holds.
   */
  const createTeam = vi.fn(async ({ workspace: ref, name, site }: CreateTeamRequest): Promise<IntentOutcome> => {
    const ws = lifetime(ref);
    if (!ws) return GONE;
    const teamName = name.trim() || nextAutoTeamName(ws);
    if (teamNameTaken(ws, teamName)) return rejected({ kind: "notTaken", what: "team" });
    const id = testTeamId(teamIdsOf(workspaces));
    ws.teams = [...(ws.teams ?? []), { id, name: teamName, location: locationAt(ws, site) }];
    return accepted({ team: id });
  });
  /** The machine's word on who works in a folder: here, the teams the deck
   * draws attached there. */
  const teamsIn = vi.fn(async (path: string) =>
    workspaces.flatMap((ws) =>
      (ws.teams ?? [])
        .filter((candidate) => candidate.location?.kind === "attached" && sameDirectory(candidate.location.cwd, path))
        .map((candidate) => candidate.id),
    ),
  );
  const openSettings = vi.fn(() => true);
  const openUsage = vi.fn(() => true);
  // A fake library, not the real one over a mocked IPC: the library's own rules
  // (validation, preconditions, composing a SKILL.md, invalidating the staged
  // views) are pinned in its suite, and what the commands owe is the calls they
  // make.
  const skills = fakeSkillsLibrary();
  const mcpLibrary = fakeMcpLibrary();
  const activityOf = vi.fn<(paneId: string) => PaneActivity | undefined>(
    () => undefined,
  );
  /** Every agent running unless a test says otherwise. */
  const reachOf = vi.fn<(paneId: string) => AgentReach | null>(() => ({ kind: "running" }));
  const dispose = registerCoreCommands(registry, {
    deck: () => deck,
    agents: () => AGENTS,
    activityOf,
    reachOf,
    activatePane,
    requestCloseAgent,
    suspendAgent,
    resumeAgent,
    updateWorkspace,
    createPane,
    createTeam,
    teamsIn,
    activateTeam,
    requestDisbandTeam,
    retryProvisioning,
    openSettings,
    openUsage,
    skills,
    mcpLibrary,
  });
  return {
    registry,
    deck,
    skills,
    mcpLibrary,
    activityOf,
    reachOf,
    activatePane,
    requestCloseAgent,
    suspendAgent,
    resumeAgent,
    updateWorkspace,
    createPane,
    createTeam,
    teamsIn,
    activateTeam,
    requestDisbandTeam,
    retryProvisioning,
    openSettings,
    openUsage,
    dispose,
  };
}

export function resetCoreCommandTestState() {
  repoMode.isRepo = false;
  repoMode.inspect = null;
  settingsState.current = null;
}
