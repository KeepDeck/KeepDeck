import { useEffect, useState } from "react";
import { probeWorktree } from "../../ipc/worktree";

/** The joiner for the probe-set fingerprint: NUL cannot appear in a path
 * (paths may legitimately contain spaces). */
const SEP = String.fromCharCode(0);

/**
 * Directories checked present/absent — probed per distinct cwd whenever the
 * set changes. Shared by the workspace journal and the global browser (both
 * gate Resume on it). Unknown (probe pending or failed) counts as PRESENT: a
 * wrong "present" merely lets Resume try and fail visibly; a wrong "missing"
 * would block a working resume. An empty cwd is always absent — there is no
 * directory to resume into.
 */
export function useDirPresence(
  cwds: readonly string[],
): ReadonlyMap<string, boolean> {
  const [presence, setPresence] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const dirs = [...new Set(cwds.filter((cwd) => cwd !== ""))].sort().join(SEP);
  useEffect(() => {
    if (dirs === "") return;
    let alive = true;
    const paths = dirs.split(SEP);
    void Promise.all(
      paths.map(async (path) => {
        try {
          return [path, (await probeWorktree(path)).exists] as const;
        } catch {
          return [path, true] as const;
        }
      }),
    ).then((entries) => {
      if (alive) setPresence(new Map(entries));
    });
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
