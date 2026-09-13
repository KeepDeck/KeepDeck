import type { GitChangedFile } from "@keepdeck/plugin-api";
import type { ChangeRow } from "./status";

/**
 * Pure presentation helpers for the History view — no React, no services.
 */

/** The revision range a drilled-in view (and its diffs) covers: one commit
 * (`sha^..sha`) or everything since the fork (`fork` vs the working tree). */
export interface GitRange {
  from: string;
  to?: string;
}

/** A commit's range: its parent to itself. A root commit's absent parent is
 * degraded host-side to the empty tree — callers never special-case it. */
export function commitRange(sha: string): GitRange {
  return { from: `${sha}^`, to: sha };
}

/** The since-the-fork range. Browsing the checkout (`rev` omitted) leaves
 * the end OPEN — the diff reaches the working tree, so uncommitted work
 * counts toward "what did this branch do". Browsing a foreign ref pins the
 * end to it: there is no working tree to reach. */
export function sinceForkRange(forkSha: string, rev?: string): GitRange {
  return rev ? { from: forkSha, to: rev } : { from: forkSha };
}

/** Which drilled-in change set a History diff belongs to: one commit, or
 * everything since the fork point. A union, not optional fields — the two
 * carry different facts (a commit its subject, the fork sweep its ref pin,
 * where `rev` omitted = the checkout, reaching the working tree). */
export type HistoryScope =
  | { kind: "commit"; sha: string; subject: string }
  | { kind: "fork"; forkSha: string; rev?: string };

/** Whether the scope's content can still move under an open peek. A commit
 * is a fixed pair of trees: nothing the repo does afterwards changes what
 * `sha^..sha` shows, so a status refresh has nothing to re-read for it. A
 * fork scope is live either way — open-ended it reaches the working tree,
 * pinned to a branch name it follows that branch. */
export function scopeIsPinned(scope: HistoryScope): boolean {
  return scope.kind === "commit";
}

/** The feed revision an open peek re-reads on. Every edit in the tree ticks
 * the status feed, and a peek re-reads its diff and file list on each tick —
 * right for a worktree row or the since-fork sweep, wasted on a commit,
 * whose range cannot move: one more `git diff` and `changedFiles` per burst
 * of keystrokes for nothing. A pinned scope therefore holds a frozen
 * revision — UNTIL the feed fails. A failed read means the repo itself may
 * be gone (the worktree was deleted under the peek), and that the peek must
 * find out for itself rather than keep showing hunks that no longer exist. */
export function readVersionFor(
  scope: HistoryScope | null,
  feed: { version: number; error: string | null },
): number {
  return scope !== null && scopeIsPinned(scope) && feed.error === null ? 0 : feed.version;
}

/** The revision range a scope's file list and diffs cover. */
export function scopeRange(scope: HistoryScope): GitRange {
  return scope.kind === "commit"
    ? commitRange(scope.sha)
    : sinceForkRange(scope.forkSha, scope.rev);
}

/** The scope's one-line label — the drill header and the peek's provenance. */
export function scopeLabel(scope: HistoryScope): string {
  return scope.kind === "commit" ? scope.subject : "Since fork";
}

/** The sha identifying the scope: the commit itself, or the fork point. */
export function scopeSha(scope: HistoryScope): string {
  return scope.kind === "commit" ? scope.sha : scope.forkSha;
}

/** First seven characters — how git itself abbreviates in one-line logs. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A compact "how long ago" for commit rows: `now`, `12m`, `5h`, `3d`, then a
 * short date. Pure — the clock comes in as `nowMs`. */
export function relativeTime(unixSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** A range-diff file as a peek row. `history` rows diff across the drilled
 * range, never against the index. Two codes name a file the range cannot
 * diff and only the working tree can show — both reachable only when the
 * range reaches the working tree: an untracked file (`?`) has no diff at
 * any range, and an unmerged one (`U`) would diff as a combined diff the
 * peek cannot read. Each becomes the row its status entry would make. */
export function historyRow(file: GitChangedFile): ChangeRow {
  return {
    path: file.path,
    origPath: file.origPath,
    code: file.code,
    kind: file.code === "?" ? "untracked" : file.code === "U" ? "conflicted" : "history",
  };
}
