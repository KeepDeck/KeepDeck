import type { GitHistory } from "@keepdeck/plugin-api";
import { relativeTime, shortSha, type HistoryScope } from "../domain/history";

/**
 * What the History section lists — the view model behind its rows. The
 * log and its since-fork summary are two projections of one range, so
 * they sit on one surface (the PR commits/files-changed model): a pinned
 * "Since fork" row when a fork applies, then the full log with the fork
 * boundary drawn AT the fork commit — everything above the divider is the
 * branch's own work, below it the base history. Each row carries the scope
 * it opens, so the view decides nothing.
 */
export type HistoryListRow =
  /** The since-fork sweep: how many commits the branch has of its own. */
  | { kind: "pin"; count: string; hint: string; scope: HistoryScope }
  /** The fork boundary, drawn before the fork commit. */
  | { kind: "fork" }
  | {
      kind: "commit";
      sha: string;
      short: string;
      subject: string;
      when: string;
      hint: string;
      scope: HistoryScope;
    }
  /** The tail while the log may go on: reaching it asks for more. */
  | { kind: "more" };

/** The row's identity for a windowed list — never its index: the window
 * grows at the bottom and a status tick can reorder nothing, but a key
 * that is the row's own survives any change above it. */
export function historyRowKey(row: HistoryListRow): string {
  return row.kind === "commit" ? row.sha : row.kind;
}

export interface HistoryList {
  rows: HistoryListRow[];
  /** The log has nothing in it. */
  empty: boolean;
}

/** What the History section's header counts: the branch's own commits since
 * the fork — the "N commits" the pinned row says — and nothing while there
 * is no fork to count from, or no log yet. */
export function historyCount(history: GitHistory | null): number | null {
  return history?.ahead ?? null;
}

export function historyList(history: GitHistory, nowMs: number, hasMore = false): HistoryList {
  const rows: HistoryListRow[] = [];
  if (history.forkSha) {
    const ahead = history.ahead ?? 0;
    rows.push({
      kind: "pin",
      count: `${ahead} ${ahead === 1 ? "commit" : "commits"}`,
      hint: `Everything since ${shortSha(history.forkSha)}, working tree included`,
      scope: { kind: "fork", forkSha: history.forkSha },
    });
  }
  for (const commit of history.commits) {
    if (commit.sha === history.forkSha) rows.push({ kind: "fork" });
    rows.push({
      kind: "commit",
      sha: commit.sha,
      short: shortSha(commit.sha),
      subject: commit.subject,
      when: relativeTime(commit.timestamp, nowMs),
      hint: `${commit.subject} — ${commit.author}`,
      scope: { kind: "commit", sha: commit.sha, subject: commit.subject },
    });
  }
  if (hasMore) rows.push({ kind: "more" });
  return { rows, empty: history.commits.length === 0 };
}
