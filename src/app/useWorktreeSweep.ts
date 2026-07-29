/**
 * Trigger only: the deck changed, so ask the worktree manager to sweep.
 *
 * It holds NO projection of the deck on purpose. An earlier version keyed the
 * effect on its own digest of `(workspace id, skill roots)` — a second,
 * independent expression of "what counts as a change" living in a React hook,
 * next to the manager's own. The two already disagreed (the manager matches a
 * workspace's LIFETIME, the digest dropped it), and the moment they drifted
 * further the sweep would silently stop firing. So the hook passes the deck
 * along and the manager decides everything: whether sweeping is safe at all,
 * whether anything it acts on actually changed, what is dead, and how a burst of
 * closes coalesces.
 *
 * Every shrink of the live set gets a sweep, not just boot: a workspace closing
 * leaves derived skill dirs behind, and an app restarted once a week would
 * otherwise carry them for a week.
 */
import { useEffect } from "react";
import type { Workspace } from "../domain/deck";
import type { WorktreeManager } from "./worktrees";

export function useWorktreeSweep(
  worktrees: WorktreeManager,
  workspaces: Workspace[],
  deckHydrated: boolean,
): void {
  useEffect(() => {
    void worktrees.sweep(deckHydrated);
    // `workspaces` is the deck store's array — a new identity only when the deck
    // actually changed, never per render — so this fires on every transition and
    // the manager shrugs off the ones that change nothing it owns.
  }, [worktrees, workspaces, deckHydrated]);
}
