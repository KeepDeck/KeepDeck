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
  stageSkills: vi.fn(),
  disarmSkills: vi.fn(async (_roots: string[]) => true),
  pruneSkills: vi.fn(async (_liveWsIds: string[]) => true),
}));
vi.mock("../../ipc/skills", () => skillsIpc);

// The MCP config is planted in the same directories by the same owner, so the
// doubles answer like the real wrappers do.
const mcpArmingIpc = vi.hoisted(() => ({
  mcpArm: vi.fn(async () => ({
    armed: [] as string[],
    refused: [] as { root: string; reason: string }[],
  })),
  mcpDisarm: vi.fn(async (_roots: string[]) => true),
  mcpPrune: vi.fn(async (_liveWsIds: string[]) => true),
}));
vi.mock("../../ipc/mcpArming", () => mcpArmingIpc);

// Re-exported through a binding of their own: a hoisted declaration cannot be
// an export itself, and the suites need the doubles they assert on.
export const worktree = worktreeIpc;
export const skills = skillsIpc;
export const mcpArming = mcpArmingIpc;

import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { SkillsStagingViews } from "../../ipc/skills";
import {
  createWorktreeManager,
  type LiveWorkspace,
  type WorktreeDeckView,
  type WorktreeManager,
} from ".";

export { planPanes } from "../provisioning";
export type { SetupStep } from "../provisioning";
export type { WorktreeManager };

/** The deck the manager reads, as a test double: what `live()` returns IS the
 * app's answer to which roots are claimed, and `rootsOf` answers from it.
 *
 * It carries the workspace INSTANCE, which `LiveWorkspace` does not: the
 * production adapter matches a workspace's LIFETIME and documents that as
 * load-bearing, and a double that knew only ids could not express the rule, let
 * alone cover it. Left off an entry, it follows [`ref`]'s default. */
export type DeckEntry = LiveWorkspace & { instance?: string };

const lifetimeOf = (ws: DeckEntry): string => ws.instance ?? `${ws.id}-life-1`;

/** A workspace REF: the id keys the disk, the instance keys the memo. */
export const ref = (id: string, instance = `${id}-life-1`): WorkspaceRef => ({
  id,
  instance,
});

export const stagedFor = (wsId: string): SkillsStagingViews => ({
  claudePluginDir: `/staging/${wsId}/claude-plugin`,
  opencodeConfigDir: `/staging/${wsId}/opencode`,
  skillsDir: `/staging/${wsId}/skills`,
});

/** The deck view over a suite's mutable array. Read through a thunk, never
 * captured: every suite reassigns that array mid-test to say "a pane left
 * while this was queued", which is the case the owner exists for. */
function deckView(read: () => DeckEntry[]): WorktreeDeckView {
  return {
    // Matched on the exact LIFETIME, like the production adapter: a reborn
    // workspace must not be handed the dead one's roots.
    rootsOf: (workspace) =>
      read().find(
        (ws) => ws.id === workspace.id && lifetimeOf(ws) === workspace.instance,
      )?.roots ?? [],
    live: () => read().map(({ id, roots }) => ({ id, roots })),
  };
}

/** A fresh manager per test: its maps are per-instance precisely so no test —
 * and no workspace — inherits another's in-flight state. */
export function managerFor(read: () => DeckEntry[]): WorktreeManager {
  return createWorktreeManager(deckView(read));
}

/** Re-arm the doubles after `resetAllMocks` wipes their implementations.
 *
 * RESET, not clear: `clearAllMocks` keeps implementations in place, so one
 * test's recording stub would answer for every test declared after it. What
 * that costs is this — every double has to say again what the real wrapper
 * says, or the owner reads `undefined` as a failure and retries it forever. */
export function armDoubles(): void {
  skills.stageSkills.mockImplementation(async (wsId: string) => stagedFor(wsId));
  skills.disarmSkills.mockResolvedValue(true);
  skills.pruneSkills.mockResolvedValue(true);
  mcpArming.mcpArm.mockResolvedValue({ armed: [], refused: [] });
  mcpArming.mcpDisarm.mockResolvedValue(true);
  mcpArming.mcpPrune.mockResolvedValue(true);
}
