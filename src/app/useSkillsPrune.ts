/**
 * Sweep dead skills dirs against the live workspace set: once when the deck
 * finishes restoring (boot — catches whatever earlier sessions or crashes
 * left behind) and again whenever the set of workspace ids changes (a close
 * cleans up immediately). One mechanism for both moments; renames don't
 * re-run it — ids, not names, key the dirs.
 *
 * `ready` must be true only for a REALLY hydrated deck: sweeping while the
 * deck is still empty-because-loading (or parked by a newer-version freeze)
 * would read as "no workspaces exist" and delete every live dir.
 */
import { useEffect } from "react";
import type { Workspace } from "../domain/deck";
import { pruneSkills } from "../ipc/skills";

export function useSkillsPrune(workspaces: Workspace[], ready: boolean): void {
  const idsKey = workspaces
    .map((ws) => ws.id)
    .sort()
    .join("\n");
  useEffect(() => {
    if (!ready) return;
    void pruneSkills(idsKey === "" ? [] : idsKey.split("\n"));
  }, [ready, idsKey]);
}
