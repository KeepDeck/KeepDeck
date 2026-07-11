import { useCallback, useEffect, useRef, useState } from "react";
import type { Disposable, GitStatus } from "@keepdeck/plugin-api";
import { getRuntime } from "../runtime";

/**
 * One repo's live status: load on mount and re-root, then follow the repo
 * through `services.git.watch` — edits, staging, commits and checkouts all
 * land here without any manual refresh (there deliberately is no button).
 *
 * Two burst guards keep this cheap:
 * - watch events are DEBOUNCED (trailing edge) so a build's thousand file
 *   writes become one re-read after the dust settles;
 * - reads are SINGLE-FLIGHT: a change during an in-flight `git status` marks
 *   it dirty and re-reads once at the end, never queueing a pile-up.
 *
 * `version` bumps on every fresh status — an open diff peek re-fetches on it,
 * so the peek follows the repo the same way the list does.
 */
const WATCH_DEBOUNCE_MS = 300;

export function useGitStatus(repo: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  // The newest wanted read (repo + generation). `load` always reads it at
  // start, so the dirty re-read after a root switch targets the NEW repo, and
  // a stale response (an old generation) never lands in state.
  const wantRef = useRef<{ repo: string; gen: number }>({ repo, gen: 0 });
  const genRef = useRef(0);
  const inflightRef = useRef(false);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    if (inflightRef.current) {
      dirtyRef.current = true;
      return;
    }
    inflightRef.current = true;
    const want = wantRef.current;
    const { services, log } = getRuntime();
    try {
      const next = await services.git.status(want.repo);
      if (want.gen === genRef.current) {
        setStatus(next);
        setError(null);
        setVersion((v) => v + 1);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn(`git status failed for ${want.repo}: ${message}`);
      if (want.gen === genRef.current) {
        setError(message);
        setStatus(null);
      }
    } finally {
      inflightRef.current = false;
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    const gen = ++genRef.current;
    wantRef.current = { repo, gen };
    setStatus(null);
    setError(null);
    void load();

    const { services, log } = getRuntime();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: Disposable | null = null;
    try {
      watcher = services.git.watch(repo, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void load();
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (cause) {
      // No watch (e.g. refused) degrades to load-on-root-switch — the tab
      // still works, it just isn't live.
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn(`git watch failed for ${repo}: ${message}`);
    }
    return () => {
      watcher?.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [repo, load]);

  return { status, error, version };
}
