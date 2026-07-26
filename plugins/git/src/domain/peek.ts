import type { ChangeRow } from "./status";
import type { GitRange } from "./history";

/**
 * Which diff the peek is showing — the SINGLE answer to "is this a different
 * diff", shared by the fetch, the stale-content clear and the scroll reset so
 * that the three can never disagree about it. No React, no services.
 */

/**
 * Every input is load-bearing. `repo`: the same path in another worktree is
 * another file. `row.kind`: it decides which diff git is even asked for
 * (index-vs-HEAD, worktree-vs-index, or the whole file for an untracked one).
 * `range`: one path browsed at two commits renders an identical name and an
 * identical header, and is not the same diff. A null row means no file has
 * been chosen yet — a History scope whose rail has not seeded one — and keys
 * apart from every real file.
 *
 * The status feed's `version` is deliberately NOT part of this. A watcher
 * refresh re-reads the SAME diff in place; folding it in would blank the body
 * and throw the reader back to the top every time the working tree moved. A
 * caller that must also refetch on it passes it alongside, which keeps that
 * one exception visible instead of hiding it in a dependency list.
 */
export function diffKey(
  repo: string,
  row: ChangeRow | null,
  range: GitRange | undefined,
): string {
  // NUL-joined: the one byte a path, a git ref name and a row kind can never
  // contain, so no combination of fields can spell out another key. A
  // printable separator would only be unambiguous for as long as every field
  // happened to avoid it.
  return [
    repo,
    row?.kind ?? "",
    row?.path ?? "",
    range?.from ?? "",
    range?.to ?? "",
  ].join("\0");
}
