import { vi } from "vitest";
import type { AgentInfo } from "../../domain/agents";
import { createCommandRegistry } from "../../domain/commands";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
  ResumeRequest,
} from "../agentOrchestrator";
import { registerCoreCommands } from "../coreCommands";
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

/** A deck stub: the live workspaces array + recording actions. */
function fakeDeck(workspaces: Workspace[]): Deck {
  return {
    workspaces,
    activeId: workspaces[0]?.id ?? "",
    viewOf: vi.fn(() => ({})),
    selectWorkspace: vi.fn(),
    selectPane: vi.fn(),
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
  const suspendAgent = vi.fn<
    (wsId: string, paneId: string) => Promise<SuspendOutcome>
  >(() => Promise.resolve("suspended"));
  const resumeAgent = vi.fn<(wsId: string, paneId: string) => ResumeRequest>(
    () => "resuming",
  );
  const createPane = vi.fn<(request: CreatePaneRequest) => CreatePaneOutcome>(
    ({ workspace: ref, pane }) => {
      const ws = workspaces.find(
        (candidate) =>
          candidate.id === ref.id && candidate.instance === ref.instance,
      );
      if (!ws) return { kind: "gone" };
      ws.panes.push(pane);
      return { kind: "created" };
    },
  );
  const openSettings = vi.fn(() => true);
  const openUsage = vi.fn(() => true);
  const dispose = registerCoreCommands(registry, {
    deck: () => deck,
    agents: () => AGENTS,
    activatePane,
    requestCloseAgent,
    suspendAgent,
    resumeAgent,
    createPane,
    openSettings,
    openUsage,
  });
  return {
    registry,
    deck,
    activatePane,
    requestCloseAgent,
    suspendAgent,
    resumeAgent,
    createPane,
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
