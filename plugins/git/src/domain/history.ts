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

/** The since-the-fork range: fork point vs the WORKING TREE (open end), so
 * uncommitted work counts toward "what did this branch do". */
export function sinceForkRange(forkSha: string): GitRange {
  return { from: forkSha };
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
