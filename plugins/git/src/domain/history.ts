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
 * range, never against the index. */
export function historyRow(file: GitChangedFile): ChangeRow {
  return {
    path: file.path,
    origPath: file.origPath,
    code: file.code,
    kind: "history",
  };
}
