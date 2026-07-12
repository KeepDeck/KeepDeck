import { useEffect, useState } from "react";
import type { GitHistory } from "@keepdeck/plugin-api";
import { getRuntime } from "../runtime";

/**
 * One repo's history feed. Piggybacks on the STATUS feed's revision instead of
 * owning a second watcher: every status refresh (edits, staging, commits,
 * checkouts — the same signals that move history) bumps `version`, and the
 * history re-reads. `enabled` gates the fetch to the History view being open —
 * the Changes view never pays for a log walk.
 */
export function useGitHistory(repo: string, version: number, enabled: boolean) {
  const [history, setHistory] = useState<GitHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new repo starts blank — stale commits from the previous root must not
  // flash while the first read is in flight.
  useEffect(() => {
    setHistory(null);
    setError(null);
  }, [repo]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const { services, log } = getRuntime();
    services.git
      .history(repo)
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
  }, [repo, version, enabled]);

  return { history, error };
}
