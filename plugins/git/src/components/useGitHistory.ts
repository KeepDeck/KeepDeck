import { useCallback, useEffect, useState } from "react";
import type { GitHistory } from "@keepdeck/plugin-api";
import { activeRuntime } from "../runtime";
import { firstWindow, widenWindow, windowFilled } from "../domain/historyWindow";

/**
 * One repo's history feed with a lazily growing window (`historyWindow`
 * holds the rule; this holds the state and reads on it).
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
  const [count, setCount] = useState(firstWindow);

  // A new repo starts blank at the first page — stale commits from the
  // previous walk must not flash while the first read is in flight.
  useEffect(() => {
    setHistory(null);
    setError(null);
    setCount(firstWindow());
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

  const hasMore = windowFilled(history, count);
  const loadMore = useCallback(() => setCount(widenWindow), []);

  return { history, error, hasMore, loadMore };
}
