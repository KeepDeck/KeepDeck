/**
 * Sweep dead skills dirs against the live workspace set: once when the deck
 * finishes restoring (boot — catches whatever earlier sessions or crashes
 * left behind) and again whenever the set of workspace ids changes (a close
 * cleans up immediately). A closing workspace also gets its spawn cwds'
 * codex-facing `.agents/skills` symlinks disarmed — its staging is about to
 * be pruned, and a surviving directory must not hold a dangling link. One
 * mechanism for all of it; renames don't re-run it — ids and paths, not
 * names, key the sweep.
 *
 * `ready` must be true only for a REALLY hydrated deck: sweeping while the
 * deck is still empty-because-loading (or parked by a newer-version freeze)
 * would read as "no workspaces exist" and delete every live dir.
 */
import { useEffect, useRef } from "react";
import type { Workspace } from "../domain/deck";
import { disarmSkills, pruneSkills } from "../ipc/skills";
import { skillRootsOf } from "../domain/deck";

export function useSkillsPrune(workspaces: Workspace[], ready: boolean): void {
  // Snapshot of the last swept deck — what a close diffs against. Keyed by
  // ids AND spawn roots so a pane added after the last sweep is still in
  // the snapshot by the time its workspace closes.
  const swept = useRef<Workspace[]>([]);
  const key = workspaces
    .map((ws) => [ws.id, ...skillRootsOf(ws)].join("\u0000"))
    .sort()
    .join("\n");
  useEffect(() => {
    if (!ready) return;
    const liveIds = new Set(workspaces.map((ws) => ws.id));
    // One rule for closed workspaces AND closed panes: a spawn cwd is
    // disarmed the moment NO live workspace claims it anymore — a pane's
    // departure must not leave its directory armed forever.
    const currentRoots = new Set(workspaces.flatMap(skillRootsOf));
    const departedRoots = [
      ...new Set(swept.current.flatMap(skillRootsOf)),
    ].filter((root) => !currentRoots.has(root));
    swept.current = workspaces;
    void disarmSkills(departedRoots);
    void pruneSkills([...liveIds].sort());
    // The key IS the workspaces digest — listing the array too would re-run
    // the sweep on every deck render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);
}
