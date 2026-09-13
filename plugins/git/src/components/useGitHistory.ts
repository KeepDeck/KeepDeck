import { useCallback, useEffect, useState } from "react";
import type { GitHistory } from "@keepdeck/plugin-api";
import { activeRuntime } from "../runtime";

/** The lazy-scroll page size: the first read asks for this many commits, and
 * every `loadMore` widens the window by the same step. */
export const HISTORY_CHUNK = 50;

/**
 * One repo's history feed with a lazily GROWING window. State is just "how
 * many commits to show": every read re-asks for the whole window (`git log
 * -n count` carries no diffs — re-listing even thousands of records is
 * cheap), which keeps the list correct when commits land underneath the
 * scroll — no cursor bookkeeping to invalidate.
 *
 * Piggybacks on the STATUS feed's revision instead of owning a second
 * watcher: every status refresh (edits, staging, commits, checkouts — the
 * same signals that move history) bumps `version`, and the window re-reads.
 * `enabled` gates the fetch to the History section being open — a person
 * who never opens it never pays for a log walk — while the window and the
 * last answer stay, so reopening the section shows what it showed.
 */
export function useGitHistory(repo: string, version: number, enabled: boolean) {
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(HISTORY_CHUNK);

  // A new repo starts blank at the first page — stale commits from the
  // previous walk must not flash while the first read is in flight.
  useEffect(() => {
    setHistory(null);
    setError(null);
    setCount(HISTORY_CHUNK);
  }, [repo]);

  useEffect(() => {
    if (!enabled) return;
    // Torn down: the host is unmounting this surface; nothing to read.
    const runtime = activeRuntime();
    if (!runtime) return;
    let cancelled = false;
    const { services, log } = runtime;
    services.git
      .history(repo, { limit: count })
      .then((next) => {
        if (cancelled) return;
        setHistory(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`git history failed for ${repo}: ${message}`);
        if (cancelled) return;
        setError(message);
        setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, version, enabled, count]);

  /** Whether scrolling further could reveal more: the last read filled its
   * whole window. A short repo underfills it and the list is complete. */
  const hasMore = history !== null && history.commits.length >= count;

  const loadMore = useCallback(() => {
    setCount((current) => current + HISTORY_CHUNK);
  }, []);

  return { history, error, hasMore, loadMore };
}
