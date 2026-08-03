/**
 * A workspace's pane LIST: adding, removing, partitioning, choosing focus.
 *
 * Everything here takes the list (or one pane) and returns a value; nothing
 * reaches for pane lifecycle rules, which is what keeps the reducer's list
 * operations free of "may this pane…" questions. What a pane is CALLED is
 * [`./titles`] — a different reason to change entirely.
 */
import { MAX_PANES } from "../layout";
import type { Pane } from "./model";

/**
 * Append an already-formed `pane` (e.g. one whose worktree is provisioned),
 * unless the fleet is already at [`MAX_PANES`]. Pure: returns the same array
 * (unchanged) when at the cap.
 */
export function appendPane(panes: Pane[], pane: Pane): Pane[] {
  if (panes.length >= MAX_PANES) return panes;
  return [...panes, pane];
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
}

/**
 * Split panes into the ones still on the grid (`live`) and the ones minimized
 * out of it (`minimized`) — the tray/strip minimize styles. A minimized id
 * that no longer matches a pane is simply ignored, so the minimized set
 * self-heals over any pane removal without every removal path having to prune
 * it. Order within each group follows the pane order; when nothing is
 * minimized the SAME `panes` array is returned as `live` (a stable ref for
 * render memoization).
 */
export function partitionPanes(
  panes: Pane[],
  minimized: readonly string[] | undefined,
): { live: Pane[]; minimized: Pane[] } {
  if (!minimized || minimized.length === 0) return { live: panes, minimized: [] };
  const set = new Set(minimized);
  const live: Pane[] = [];
  const out: Pane[] = [];
  for (const pane of panes) (set.has(pane.id) ? out : live).push(pane);
  return { live, minimized: out };
}

/**
 * The pane that should render maximized, or `null` when none does. A workspace
 * with a single pane is never maximized ([U1]: maximize is a no-op on a solo
 * pane — the lone tile already fills the grid), and a `focusedId` that no longer
 * matches any pane (e.g. the maximized pane was just closed) resolves to none.
 */
export function resolveFocus(
  panes: Pane[],
  focusedId: string | undefined,
): string | null {
  if (!focusedId || panes.length <= 1) return null;
  return panes.some((pane) => pane.id === focusedId) ? focusedId : null;
}
