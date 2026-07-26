import type { ChangeRow } from "./status";
import type { GitRange } from "./history";

/**
 * What the git views are looking at, as comparable values — the single answer
 * to "is this still the same thing?", so a fetch, a stale-content clear and a
 * scroll reset can never disagree about it. No React, no services.
 *
 * Keys join on NUL: the one byte a path, a git ref name and a row kind cannot
 * contain, so no combination of fields can spell out another's key.
 */

/** A set of changes: one repo over one revision range, or its worktree when
 * there is no range. `repo` is load-bearing — two worktrees of one repo share
 * shas, so a range alone would call two different file lists the same list. */
export function changeSetKey(
  repo: string,
  range: GitRange | undefined,
): string {
  return [repo, range?.from ?? "", range?.to ?? ""].join("\0");
}

/**
 * One file within a change set. `row.kind` counts because it decides which
 * diff git is even asked for — index-vs-HEAD, worktree-vs-index, or the whole
 * file for an untracked one. A null row is "no file chosen yet", the History
 * scope whose rail has not seeded one, and keys apart from every real file.
 *
 * The status feed's `version` is deliberately absent: a watcher refresh
 * re-reads the SAME diff in place, and folding it in would blank the body and
 * throw the reader back to the top whenever the working tree moved. Callers
 * that must refetch on it pass it alongside, keeping that one exception
 * visible rather than buried in a dependency list.
 */
export function diffKey(
  repo: string,
  row: ChangeRow | null,
  range: GitRange | undefined,
): string {
  return [changeSetKey(repo, range), row?.kind ?? "", row?.path ?? ""].join(
    "\0",
  );
}
