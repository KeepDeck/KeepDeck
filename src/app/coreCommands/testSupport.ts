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
  claimDirectory,
  MAX_PANES,
  nextAutoTeamName,
  normalizePath,
  teamHeldPath,
  teamIdsOf,
  teamNameTaken,
  type Workspace,
} from "../../domain/deck";
import { testTeamId } from "../../domain/deck/teams/testSupport";
import { admitRole } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
  CreateTeamOutcome,
  CreateTeamRequest,
  ResumeRequest,
} from "../agentOrchestrator";
import { teamCreateRefusal } from "../agentOrchestrator/creation";
import { fakeMcpLibrary } from "../mcpLibrary.fake";
import { fakeSkillsLibrary } from "../skillsLibrary.fake";
import { registerCoreCommands } from ".";
import type { SuspendOutcome } from "../suspendOutcome";
import type { Deck } from "../useDeck";

export const HOST = { kind: "host" } as const;

// Repo inspection is per-test switchable; suggestions follow the real Rust
// naming (kd/<ws>/<i> ↔ kd-<ws>-<i>); probes report every path free.
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
  suggestWorktree: async (workspace: string, index: number) => ({
    branch: `kd/${workspace}/${index}`,
    folder: `kd-${workspace}-${index}`,
  }),
  probeWorktree: async () => ({
    exists: false,
    isWorktree: false,
    empty: false,
    branch: null,
  }),
  createWorktree: async () => {
    throw new Error("not under test");
  },
  removeWorktree: async () => {},
}));

const hoistedSettingsState = vi.hoisted(() => ({
  current: null as { defaultYolo?: boolean } | null,
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

/** A deck stub: the live workspaces array + recording actions. */
function fakeDeck(workspaces: Workspace[]): Deck {
  return {
    workspaces,
    activeId: workspaces[0]?.id ?? "",
    viewOf: vi.fn(() => ({})),
    selectWorkspace: vi.fn(),
    selectPane: vi.fn(),
    renameTeam: vi.fn(),
  } as unknown as Deck;
}

export function setup(workspaces: Workspace[]) {
  const registry = createCommandRegistry();
  const deck = fakeDeck(workspaces);
  const requestCloseAgent = vi.fn();
  const activatePane = vi.fn((wsId: string, paneId: string) => {
    deck.selectWorkspace(wsId);
    deck.selectPane(wsId, paneId);
  });
  const activateTeam = vi.fn();
  const requestDisbandTeam = vi.fn();
  const retryProvisioning = vi.fn();
  const suspendAgent = vi.fn<
    (wsId: string, paneId: string) => Promise<SuspendOutcome>
  >(() => Promise.resolve("suspended"));
  const resumeAgent = vi.fn<(wsId: string, paneId: string) => ResumeRequest>(
    () => "resuming",
  );
  // The landing, as a double: a request naming a team joins it (a team not
  // here refuses, a full one refuses), any other request mints a team at
  // the directory it asked for (the root when it asked for none) under the
  // name it gave, and the pane joins under the role it asked for when free
  // — the shape the real landing leaves, minus the join-the-holder rule the
  // orchestrator's own suite pins.
  const createPane = vi.fn<(request: CreatePaneRequest) => CreatePaneOutcome>(
    ({ workspace: ref, pane, placement, team, role, teamName }) => {
      const ws = workspaces.find(
        (candidate) =>
          candidate.id === ref.id && candidate.instance === ref.instance,
      );
      if (!ws) return { kind: "gone" };
      let teamId: string;
      if (team !== undefined) {
        if (!ws.teams?.some((candidate) => candidate.id === team)) {
          return { kind: "held", why: "refused" };
        }
        teamId = team;
      } else {
        teamId = testTeamId(teamIdsOf(workspaces));
        ws.teams = [
          ...(ws.teams ?? []),
          {
            id: teamId,
            name: teamName ?? teamId,
            location: placement ?? { kind: "attached", cwd: ws.cwd },
          },
        ];
      }
      if (ws.panes.filter((candidate) => candidate.team?.teamId === teamId).length >= MAX_PANES) {
        return { kind: "full" };
      }
      // The one rule the real landing asks, asked here too rather than
      // re-spelled: a hand-rolled "taken → suggest" lived here once and
      // answered "created" for a role the landing would refuse.
      const admitted = admitRole(ws, teamId, role);
      if (!admitted.ok) return { kind: "role", why: admitted.why, role: admitted.role, open: admitted.open };
      ws.panes.push({ ...pane, team: { teamId, role: admitted.role } });
      return { kind: "created", teamId };
    },
  );
  /**
   * The team door, as a double: a team minted EMPTY at the directory it asked
   * for, under the name it gave ("Team N" for none).
   *
   * Nothing the real door DECIDES is re-implemented here — the refusal comes
   * from `teamCreateRefusal` over `claimDirectory`, and the auto-name from
   * `nextAutoTeamName`, the helper production names with. The id is the
   * test's predictable `testTeamId` where production mints a random one. What it does NOT model, because a
   * command test has no running deck: a teardown holding the directory
   * (`holdsPath`) and the post-dispatch read-back. Reach those through the
   * orchestrator's own suite, or by stubbing this mock's return.
   */
  const createTeam = vi.fn<(request: CreateTeamRequest) => CreateTeamOutcome>(
    ({ workspace: ref, name, placement, shared }) => {
      const ws = workspaces.find(
        (candidate) =>
          candidate.id === ref.id && candidate.instance === ref.instance,
      );
      if (!ws) return { kind: "gone" };
      const refusal = teamCreateRefusal({
        claim: claimDirectory(workspaces, ws, placement),
        placement,
        homeWsId: ws.id,
        directory: normalizePath(teamHeldPath({ location: placement }) ?? ""),
        shared: shared === true,
      });
      if (refusal) return refusal;
      const teamName = name.trim() || nextAutoTeamName(ws);
      if (teamNameTaken(ws, teamName)) return { kind: "taken" };
      const id = testTeamId(teamIdsOf(workspaces));
      ws.teams = [...(ws.teams ?? []), { id, name: teamName, location: placement }];
      return { kind: "created", teamId: id };
    },
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
  const dispose = registerCoreCommands(registry, {
    deck: () => deck,
    agents: () => AGENTS,
    activityOf,
    activatePane,
    requestCloseAgent,
    suspendAgent,
    resumeAgent,
    createPane,
    createTeam,
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
    activatePane,
    requestCloseAgent,
    suspendAgent,
    resumeAgent,
    createPane,
    createTeam,
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
