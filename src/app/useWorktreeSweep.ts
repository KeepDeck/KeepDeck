/**
 * Trigger only: the deck's shape changed, so ask the worktree manager to sweep.
 *
 * Every decision belongs to the manager ([`app/worktrees`]) — whether sweeping
 * is safe at all (an unhydrated deck reads as "no workspaces exist"), what is
 * dead, and coalescing a burst of closes into a single pass. This hook exists
 * only because React is where the deck's transitions are observed, and it holds
 * no policy so that no second place can disagree with the manager about what a
 * live root is.
 *
 * Every shrink of the live set gets a sweep, not just boot: a workspace closing
 * leaves derived skill dirs behind, and an app that is restarted once a week
 * would otherwise carry them for a week. Renames do not re-run it — ids and
 * roots key the digest, never names.
 */
import { useEffect } from "react";
import { skillRootsOf, type Workspace } from "../domain/deck";
import type { WorktreeManager } from "./worktrees";

export function useWorktreeSweep(
  worktrees: WorktreeManager,
  workspaces: Workspace[],
  deckHydrated: boolean,
): void {
  const digest = workspaces
    .map((ws) => JSON.stringify([ws.id, ...skillRootsOf(ws)]))
    .sort()
    .join("\n");
  useEffect(() => {
    void worktrees.sweep(deckHydrated);
    // The digest IS the workspaces' identity here; listing the array too would
    // re-run this on every deck render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktrees, deckHydrated, digest]);
}
