import { useCallback, useEffect, useRef, useState } from "react";
import type { Disposable } from "@keepdeck/plugin-api";
import { getRuntime } from "../runtime";
import {
  initTree,
  refreshTargets,
  setChildren,
  setError,
  setLoading,
  toggleExpanded,
  type TreeState,
} from "../domain/tree";

/**
 * The Files tab's tree state and the async orchestration over `services.fs`.
 * The model transforms are pure (`domain/tree`); this hook awaits the platform
 * and threads results back in — and keeps every loaded directory LIVE, watching
 * it so a change on disk refreshes it automatically, no button press.
 *
 * `rootPath` is the directory the tree is rooted at (a workspace folder or a
 * pane worktree). Changing it re-roots: a fresh tree, a load of the new root,
 * and every old watcher torn down.
 */
/** Coalesce a burst of fs events for one directory into a single re-read. */
const WATCH_DEBOUNCE_MS = 250;

export function useFileTree(rootPath: string) {
  const [state, setState] = useState<TreeState>(() => initTree(rootPath));
  // One live watcher per loaded directory, plus its pending debounced re-read.
  const watchesRef = useRef<Map<string, Disposable>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** Fetch (or re-fetch) one directory's children, then watch it: a structural
   * change on disk schedules a debounced re-read, so the tree stays current. */
  const load = useCallback(async (path: string) => {
    const { services, log } = getRuntime();
    setState((current) => setLoading(current, path));
    try {
      const entries = await services.fs.readDir(path);
      setState((current) => setChildren(current, path, entries));
      if (!watchesRef.current.has(path)) {
        watchesRef.current.set(
          path,
          services.fs.watch(path, () => {
            const timers = timersRef.current;
            const pending = timers.get(path);
            if (pending) clearTimeout(pending);
            timers.set(
              path,
              setTimeout(() => {
                timers.delete(path);
                void load(path);
              }, WATCH_DEBOUNCE_MS),
            );
          }),
        );
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn(`readDir failed for ${path}: ${message}`);
      setState((current) => setError(current, path, message));
    }
  }, []);

  // Re-root when the target changes; tear down every watcher and pending reload
  // on re-root or unmount.
  useEffect(() => {
    setState(initTree(rootPath));
    void load(rootPath);
    const watches = watchesRef.current;
    const timers = timersRef.current;
    return () => {
      for (const watcher of watches.values()) watcher.dispose();
      watches.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [rootPath, load]);

  /** Expand/collapse a directory, loading (and thereby watching) its children on
   * first expand. The load decision reads the CURRENT node so the async call
   * fires once, outside the (double-invoked in StrictMode) state updater. */
  const toggle = useCallback(
    (path: string) => {
      const node = state.nodes[path];
      if (!node || node.kind !== "dir") return;
      if (!node.expanded && !node.loaded && !node.loading) void load(path);
      setState((current) => toggleExpanded(current, path));
    },
    [state, load],
  );

  /** Re-read every visible directory now (the manual Refresh), keeping
   * expansion intact — a belt to the automatic watchers. */
  const refresh = useCallback(() => {
    for (const path of refreshTargets(state)) void load(path);
  }, [state, load]);

  return { state, toggle, refresh };
}
