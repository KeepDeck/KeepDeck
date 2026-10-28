import { vi } from "vitest";

/**
 * What the three worktree suites share: the IPC doubles the owner is driven
 * against, the deck double it reads, and a fresh manager per test.
 *
 * The mocks live HERE rather than three times over, so a double added for one
 * suite's new case cannot be missing from the other two — which is exactly how
 * a wrapper the owner treats as infallible came to answer `undefined` in two
 * of the three suites. Everything a suite needs is re-exported from here, and
 * suites import nothing else from the module graph: a direct import of a
 * mocked module would load the real one before these registrations run.
 */

const worktreeIpc = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

// The IPC wrappers report whether they got through — the owner only records a
// sweep as done when they did — so the doubles answer `true` like the real ones.
const skillsIpc = vi.hoisted(() => ({
  fetchSkills: vi.fn(async () => [] as { scope: "global"; wsId: null; name: string; content: string }[]),
  stageSkills: vi.fn(),
  disarmSkills: vi.fn(async (_roots: string[]) => true),
  pruneSkills: vi.fn(async (_liveWsIds: string[]) => true),
}));
vi.mock("../../ipc/skills", () => skillsIpc);

// The MCP configs earlier builds planted are taken back by the same owner, so
// the doubles answer like the real wrappers do.
const mcpArmingIpc = vi.hoisted(() => ({
  mcpDisarm: vi.fn(async (_roots: string[]) => true),
  mcpPrune: vi.fn(async (_liveWsIds: string[]) => true),
}));
vi.mock("../../ipc/mcpArming", () => mcpArmingIpc);

// What agents' plugins plant in a pane's cwd is taken back by the same pass.
const cwdArmIpc = vi.hoisted(() => ({
  cwdArm: vi.fn(async () => ({ armed: [] as string[], refused: [] as { path: string; reason: string }[] })),
  cwdDisarm: vi.fn(async (_roots: readonly string[]) => true),
  cwdArmPrune: vi.fn(async (_liveWsIds: readonly string[]) => true),
}));
vi.mock("../../ipc/cwdArm", () => cwdArmIpc);

// The library's own sweep rides the same pass.
const mcpLibraryIpc = vi.hoisted(() => ({
  pruneMcpLibrary: vi.fn(async (_liveWsIds: string[]) => true),
}));
vi.mock("../../ipc/mcpLibrary", () => mcpLibraryIpc);

// Re-exported through a binding of their own: a hoisted declaration cannot be
// an export itself, and the suites need the doubles they assert on.
export const worktree = worktreeIpc;
export const skills = skillsIpc;
export const mcpArming = mcpArmingIpc;
export const mcpLibrary = mcpLibraryIpc;
export const cwdArming = cwdArmIpc;
/** Plugins' private directories, pruned by the same pass. */
export const pluginDirs = { prune: vi.fn(async (_liveWsIds: readonly string[]) => true) };

import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { WorkspaceInstance } from "../../domain/workspaceInstance";
import type { ProvisionRequest } from "./index";
import { createSkillsStaging, createWorktreePlantings } from "../worktreePlantings";
import {
  createWorktreeManager,
  deckViewOf,
  type LiveWorkspace,
  type WorktreeDeckView,
  type WorktreePlantingFactories,
  type WorktreeManager,
} from ".";

export type { WorktreeManager };

/** `count` teams waiting on their worktrees — the shape `provision` is
 * handed, as production builds it: one request per owner (a TEAM,
 * `team-N`), each intent carrying the exact path its create will land at.
 *
 * More than one because the runner still fans out over whatever it is given,
 * and only a set makes that fan-out — and the base commit pinned across it —
 * observable. */
export const provisionRequests = (count: number): ProvisionRequest[] =>
  Array.from({ length: count }, (_, i) => ({
    ownerId: `team-${i + 1}`,
    intent: { repo: "/repo", path: `/wt/team-${i + 1}`, index: i + 1 },
  }));

/** The deck the manager reads, as a test double: what `live()` returns IS the
 * app's answer to which roots are claimed, and `rootsOf` answers from it.
 *
 * It carries the workspace INSTANCE, which `LiveWorkspace` does not: the
 * production adapter matches a workspace's LIFETIME and documents that as
 * load-bearing, and a double that knew only ids could not express the rule, let
 * alone cover it. Left off an entry, it follows [`ref`]'s default. */
export type DeckEntry = LiveWorkspace & { instance?: string };

const lifetimeOf = (ws: DeckEntry): string => ws.instance ?? `${ws.id}-life-1`;

/** The suites speak plain strings for lifetimes; this names that boundary
 * without an assertion in the deck view below. */
function workspaceInstance(value: string): WorkspaceInstance;
function workspaceInstance(value: string): string {
  return value;
}

/** A workspace REF: the id keys the disk, the instance keys the memo. */
export const ref = (id: string, instance = `${id}-life-1`): WorkspaceRef => ({
  id,
  instance,
});

export const stagedFor = (wsId: string) => ({
  claudePluginDir: `/staging/${wsId}/claude-plugin`,
  opencodeConfigDir: `/staging/${wsId}/opencode`,
  skillsDir: `/staging/${wsId}/skills`,
  dir: `/staging/${wsId}/skills`,
  skills: [{ name: "review", content: "---\ndescription: Reviews\n---\n" }],
});

/** The deck view over a suite's mutable array, through the PRODUCTION
 * projection — the lifetime match is load-bearing (ids are reusable,
 * instances are not) and a hand-copied one here meant a regression in the
 * real closure would have broken nothing that runs.
 *
 * Read through a thunk, never captured: every suite reassigns that array
 * mid-test to say "a pane left while this was queued", which is the case the
 * owner exists for. */
function deckView(read: () => DeckEntry[]): WorktreeDeckView {
  return deckViewOf(() =>
    read().map((ws) => ({
      id: ws.id,
      // Branded at the boundary: the suites speak in plain strings so a test
      // can write "life-1" and mean it.
      instance: workspaceInstance(lifetimeOf(ws)),
      name: ws.id,
      cwd: "/repo",
      worktreeBaseDir: null,
      // The entries carry ROOTS, which is what `skillRootsOf` derives from
      // panes through their teams — so one team per root, with one member
      // each, reproduces them exactly.
      panes: ws.roots.map((_root, i) => ({
        id: `${ws.id}-p${i}`,
        agentType: "claude",
        team: { teamId: `${ws.id}-t${i}`, role: "lead" },
      })),
      teams: ws.roots.map((root, i) => ({
        id: `${ws.id}-t${i}`,
        name: `t${i}`,
        location: { kind: "attached" as const, cwd: root },
      })),
    })),
  );
}

/** A fresh manager per test: its maps are per-instance precisely so no test —
 * and no workspace — inherits another's in-flight state. */
export function managerFor(read: () => DeckEntry[]): WorktreeManager {
  const factories: WorktreePlantingFactories = {
    skills: createSkillsStaging,
    prunePluginDirs: pluginDirs.prune,
    onDisarmed: () => {},
  };
  return createWorktreeManager(deckView(read), (deck, inOrder) =>
    createWorktreePlantings(deck, inOrder, factories),
  );
}

/** Re-arm the doubles after `resetAllMocks` wipes their implementations.
 *
 * RESET, not clear: `clearAllMocks` keeps implementations in place, so one
 * test's recording stub would answer for every test declared after it. What
 * that costs is this — every double has to say again what the real wrapper
 * says, or the owner reads `undefined` as a failure and retries it forever. */
export function armDoubles(): void {
  skills.fetchSkills.mockResolvedValue([]);
  skills.stageSkills.mockImplementation(async (wsId: string) => stagedFor(wsId));
  skills.disarmSkills.mockResolvedValue(true);
  skills.pruneSkills.mockResolvedValue(true);
  mcpArming.mcpDisarm.mockResolvedValue(true);
  mcpArming.mcpPrune.mockResolvedValue(true);
  mcpLibrary.pruneMcpLibrary.mockResolvedValue(true);
  pluginDirs.prune.mockResolvedValue(true);
  cwdArming.cwdArm.mockResolvedValue({ armed: [], refused: [] });
  cwdArming.cwdDisarm.mockResolvedValue(true);
  cwdArming.cwdArmPrune.mockResolvedValue(true);
}
