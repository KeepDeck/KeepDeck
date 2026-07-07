import { useCallback, useEffect, useState } from "react";
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
 * The model transforms are pure (`domain/tree`); this hook is the only place
 * that awaits the platform and threads results back in.
 *
 * `rootPath` is the directory the tree is rooted at (a workspace folder or a
 * pane worktree). Changing it re-roots: a fresh tree and a load of the new root.
 */
export function useFileTree(rootPath: string) {
  const [state, setState] = useState<TreeState>(() => initTree(rootPath));

  /** Fetch (or re-fetch) one directory's children into the tree. */
  const load = useCallback(async (path: string) => {
    const { services, log } = getRuntime();
    setState((current) => setLoading(current, path));
    try {
      const entries = await services.fs.readDir(path);
      setState((current) => setChildren(current, path, entries));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn(`readDir failed for ${path}: ${message}`);
      setState((current) => setError(current, path, message));
    }
  }, []);

  // Re-root when the target directory changes.
  useEffect(() => {
    setState(initTree(rootPath));
    void load(rootPath);
  }, [rootPath, load]);

  /** Expand/collapse a directory, loading its children on first expand. The
   * load decision reads the CURRENT node so the async call fires once, outside
   * the (double-invoked in StrictMode) state updater. */
  const toggle = useCallback(
    (path: string) => {
      const node = state.nodes[path];
      if (!node || node.kind !== "dir") return;
      if (!node.expanded && !node.loaded && !node.loading) void load(path);
      setState((current) => toggleExpanded(current, path));
    },
    [state, load],
  );

  /** Re-read every visible directory from disk, keeping expansion intact. */
  const refresh = useCallback(() => {
    for (const path of refreshTargets(state)) void load(path);
  }, [state, load]);

  return { state, toggle, refresh };
}
