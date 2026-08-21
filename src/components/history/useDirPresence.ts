import { useEffect, useMemo, useRef, useState } from "react";
import { probeWorktree } from "../../ipc/worktree";

/** The joiner for the probe-set fingerprint: NUL cannot appear in a path
 * (paths may legitimately contain spaces). */
const SEP = String.fromCharCode(0);

/**
 * Directories checked present/absent — probed per distinct cwd. Shared by
 * the workspace journal and the global browser (both gate Resume on it).
 * Unknown (probe pending or failed) counts as PRESENT: a wrong "present"
 * merely lets Resume try and fail visibly; a wrong "missing" would block
 * a working resume. An empty cwd is always absent — there is no
 * directory to resume into.
 *
 * A probe is not a stat: it checks the worktree root and reads the
 * branch too. When the set GROWS (a page lands), only the ADDED paths
 * are probed — known answers carry over untouched, so a page landing
 * costs its own new paths, never the whole list again (the re-probe-all
 * of every page was a measured scroll hitch). A path that LEAVES the
 * set forgets its answer: nobody reads presence for an unmounted cwd,
 * and forgetting is what makes a RE-ENTERING path ask fresh — no
 * forever-cache, the file system may have changed while nobody watched.
 */
export function useDirPresence(
  cwds: readonly string[],
): ReadonlyMap<string, boolean> {
  const [presence, setPresence] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const answersRef = useRef<Map<string, boolean>>(new Map());
  // The fingerprint is MEMOIZED on the caller's array identity: the
  // filter-set-sort-join walked every path on EVERY render (tick
  // included) even when the caller had memoized the array itself —
  // the dedup then only stopped the probes, not the walk. With a
  // memoized input array (the browser's contract since the clock
  // landed inside), an unrelated render no longer touches the paths
  // at all; a real change (new array) recomputes the fingerprint.
  const dirs = useMemo(
    () => [...new Set(cwds.filter((cwd) => cwd !== ""))].sort().join(SEP),
    [cwds],
  );
  useEffect(() => {
    if (dirs === "") return;
    let alive = true;
    const paths = dirs.split(SEP);
    // Answers live ONLY while their path is in the set: a path that
    // left drops its answer, so its RE-ENTRY asks fresh (no
    // forever-cache — the file system may have changed while nobody
    // watched). The set's GROWTH stays incremental: known paths never
    // re-ask while they remain in the set.
    const live = new Set(paths);
    for (const p of answersRef.current.keys()) {
      if (!live.has(p)) answersRef.current.delete(p);
    }
    const fresh = paths.filter((p) => !answersRef.current.has(p));
    const answer = (entries: readonly (readonly [string, boolean])[]) => {
      if (!alive) return;
      for (const [p, v] of entries) answersRef.current.set(p, v);
      // The NEXT map carries every asked path's answer — carried and
      // fresh alike — so the render sees the whole live set's presence.
      setPresence(
        new Map(paths.map((p) => [p, answersRef.current.get(p)!])),
      );
    };
    if (fresh.length === 0) {
      answer([]);
      return;
    }
    void Promise.all(
      fresh.map(async (path) => {
        try {
          return [path, (await probeWorktree(path)).exists] as const;
        } catch {
          return [path, true] as const;
        }
      }),
    ).then(answer);
    return () => {
      alive = false;
    };
  }, [dirs]);
  return presence;
}

/** Whether `cwd` can host a resume right now, per the probe map's contract
 * (unknown = yes, empty = never). */
export function dirPresent(
  presence: ReadonlyMap<string, boolean>,
  cwd: string,
): boolean {
  if (cwd === "") return false;
  return presence.get(cwd) !== false;
}
