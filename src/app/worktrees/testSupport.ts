import { vi } from "vitest";

/**
 * What the worktree suites share: the IPC doubles the owner is driven
 * against, the deck double it reads, and a fresh owner per test.
 *
 * Everything a suite needs is re-exported from here, and suites import
 * nothing else from the module graph: a direct import of a mocked module
 * would load the real one before these registrations run.
 */

const skillsIpc = vi.hoisted(() => ({
  fetchSkills: vi.fn(async () => [] as { scope: "global"; wsId: null; name: string; content: string }[]),
  stageSkills: vi.fn(),
}));
vi.mock("../../ipc/skills", () => skillsIpc);

const cwdArmIpc = vi.hoisted(() => ({
  cwdArm: vi.fn(async () => ({ armed: [] as string[], refused: [] as { path: string; reason: string }[] })),
}));
vi.mock("../../ipc/cwdArm", () => cwdArmIpc);

// Re-exported through a binding of their own: a hoisted declaration cannot be
// an export itself, and the suites need the doubles they assert on.
export const skills = skillsIpc;
export const cwdArming = cwdArmIpc;

import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { WorkspaceInstance } from "../../domain/workspaceInstance";
import { createSkillsStaging, createWorktreePlantings } from "../worktreePlantings";
import { createStagingTrimStore, type StagingTrimStore } from "../stagingTrims";
import { deckViewOf, type WorktreePlantings } from ".";

export type { WorktreePlantings };

/** One workspace of the deck double. Its INSTANCE is optional: the
 * production adapter matches a workspace's LIFETIME and documents that as
 * load-bearing, and the suites name one only where a lifetime matters. Left
 * off, it follows [`ref`]'s default. The deck view names each workspace by
 * its id. */
export interface DeckEntry {
  id: string;
  instance?: string;
}

/** The suites speak plain strings for lifetimes; this names that boundary
 * without an assertion in the deck view below. */
function workspaceInstance(value: string): WorkspaceInstance;
function workspaceInstance(value: string): string {
  return value;
}

/** A workspace REF: the id keys the disk, the instance names the lifetime a
 * stage reports under. */
export const ref = (id: string, instance = `${id}-life-1`): WorkspaceRef => ({
  id,
  instance,
});

export const stagedFor = (wsId: string) => ({
  dir: `/staging/${wsId}/skills`,
  skills: [{ name: "review", content: "---\ndescription: Reviews\n---\n" }],
});

/** The native stage's whole answer: `stagedFor`'s views, and nothing trimmed. */
export const stageAnswerFor = (wsId: string) => ({ view: stagedFor(wsId), trims: [] });

/** A fresh owner per test, over the deck as the suite's thunk reads it NOW,
 * through the PRODUCTION projection — a hand-copied one here meant a
 * regression in the real lifetime match would have broken nothing that runs.
 * What staging could not hand out whole lands in `trims`, a fresh store
 * unless a suite reads it. */
export function plantingsFor(read: () => DeckEntry[], trims: StagingTrimStore = createStagingTrimStore()): WorktreePlantings {
  const deck = deckViewOf(() =>
    read().map((ws) => ({
      id: ws.id,
      instance: workspaceInstance(ws.instance ?? `${ws.id}-life-1`),
      name: ws.id,
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [],
      teams: [],
    })),
  );
  return createWorktreePlantings(createSkillsStaging(deck, trims));
}

/** Re-arm the doubles after `resetAllMocks` wipes their implementations.
 *
 * RESET, not clear: `clearAllMocks` keeps implementations in place, so one
 * test's recording stub would answer for every test declared after it. */
export function armDoubles(): void {
  skills.fetchSkills.mockResolvedValue([]);
  skills.stageSkills.mockImplementation(async (wsId: string) => stageAnswerFor(wsId));
  cwdArming.cwdArm.mockResolvedValue({ armed: [], refused: [] });
}
