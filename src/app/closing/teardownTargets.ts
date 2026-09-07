/**
 * Which worktrees a close actually removes — ONE decision, two moments.
 *
 * The confirmation surface asks it to write the sentence the person ticks;
 * the teardown asks it again, against the live deck, to do the removing. Both
 * must give the same answer: an offer to delete a directory the teardown will
 * spare is a promise the close cannot keep, and the two used to be assembled
 * by hand at both ends — which is how the "still lived in" rule had to be
 * written twice and the dedupe ended up in only one of them.
 *
 * The steps, in order: collect what the teams hold (plus what a dialog froze
 * and what a create ticket made), fold repeats of one directory into one
 * target, leave the workspace root alone, and leave every directory someone
 * still works in. Whether the directory is still THERE is a question for the
 * disk, which is why [`existingTargets`] is separate and async.
 */
import type { PathProbe } from "../../domain/agents";
import {
  directoriesStillHeld,
  normalizePath,
  worktreeTargets,
  type GitPosition,
  type Workspace,
  type WorktreeTarget,
} from "../../domain/deck";

/** A worktree a create ticket reported making — the directory that would
 * otherwise be nobody's, since the team was gone before it landed. */
export interface CreatedTarget {
  path: string;
  branch?: string;
  repo?: string;
}

export interface TeardownTargetsInput {
  /** Every workspace, live: sharing crosses them, so what keeps a directory
   * alive may be in another one. */
  workspaces: readonly Workspace[];
  /** The workspace being closed, as the deck holds it now — `undefined` when
   * it is already gone, in which case only `frozen`/`created` can contribute. */
  workspace: Workspace | undefined;
  /** The workspace's own folder: never a deletion target, structurally. */
  root: string;
  /** The teams this close is ending. */
  ending: readonly string[];
  /** Teams another in-flight close has taken. They are leaving too, so they
   * keep no directory alive — without this, two closes each spare a shared
   * directory on the other's behalf and neither removes it. */
  alsoLeaving?: readonly string[];
  /** Observed HEADs, for naming the branch a target carries. */
  gitPositions?: ReadonlyMap<string, GitPosition>;
  /** Targets a confirmation surface froze when it opened. */
  frozen?: readonly WorktreeTarget[];
  /** What the create tickets actually made, `null` for none. */
  created?: readonly (CreatedTarget | null)[];
}

export function deletableWorktrees(input: TeardownTargetsInput): WorktreeTarget[] {
  const { workspaces, workspace, root, ending, gitPositions, frozen, created } = input;
  const rootKey = normalizePath(root);
  const kept = directoriesStillHeld(workspaces, workspace?.id ?? "", [
    ...ending,
    ...(input.alsoLeaving ?? []),
  ]);
  const collected: WorktreeTarget[] = [
    ...(frozen ?? []),
    ...ending.flatMap((teamId) =>
      workspace ? worktreeTargets(workspace, teamId, gitPositions) : [],
    ),
    ...(created ?? []).flatMap((made) =>
      made === null ? [] : [{ repo: made.repo ?? root, path: made.path, branch: made.branch }],
    ),
  ];
  const byPath = new Map<string, WorktreeTarget>();
  for (const target of collected) {
    const key = normalizePath(target.path);
    // The root is never a deletion target, and neither is a directory a team
    // that OUTLIVES this close still works in.
    if (key === rootKey || kept.has(key) || byPath.has(key)) continue;
    byPath.set(key, target);
  }
  return [...byPath.values()];
}

/**
 * The targets that are still THERE — the disk's half of the answer, asked by
 * the confirmation surface so a directory already gone is never offered.
 *
 * Only a positive "not there" drops a target: a probe that REJECTS (IPC
 * trouble, not a missing path) keeps it, degrading to the old always-offer
 * behavior rather than quietly shrinking the offer.
 */
export async function existingTargets(
  candidates: readonly WorktreeTarget[],
  probe: (path: string) => Promise<PathProbe>,
): Promise<WorktreeTarget[]> {
  const checked = await Promise.all(
    candidates.map((target) =>
      probe(target.path).then(
        (probed) => (probed.exists ? [target] : []),
        () => [target],
      ),
    ),
  );
  return checked.flat();
}
