/**
 * A workspace's pane LIST: adding, removing, partitioning, choosing focus.
 *
 * Everything here takes the list (or one pane) and returns a value; nothing
 * reaches for pane lifecycle rules, which is what keeps the reducer's list
 * operations free of "may this pane…" questions. What a pane is CALLED is
 * [`./titles`] — a different reason to change entirely.
 */
import type { Pane } from "./model";

/**
 * Append an already-formed `pane` (e.g. one whose worktree is provisioned),
 * unless the fleet is already at [`MAX_PANES`]. Pure: returns the same array
 * (unchanged) when at the cap.
 */
export function appendPane(panes: Pane[], pane: Pane): Pane[] {
  // No cap here: the cap is the TEAM's — its panes are what the grid lays
  // out — and `joinTeam` refuses a seventeenth member. A workspace holds as
  // many teams as it is given.
  return [...panes, pane];
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
}

/**
 * The pane of `panes` — one grid: a team's panes — that should render
 * maximized, or `null` when none does. `focused` is every team's spotlight
 * (`WorkspaceView.focus`), so the one that answers is the one on this grid.
 * A grid with a single pane is never maximized ([U1]: maximize is a no-op on
 * a solo pane — the lone tile already fills the grid), and a spotlight that
 * no longer matches any pane (e.g. the maximized pane was just closed)
 * resolves to none.
 */
export function resolveFocus(
  panes: readonly Pane[],
  focused: readonly string[] | undefined,
): string | null {
  if (!focused || panes.length <= 1) return null;
  return panes.find((pane) => focused.includes(pane.id))?.id ?? null;
}
