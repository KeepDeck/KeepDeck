import { MAX_PANES, clampPaneCount } from "./layout";

/** One agent pane in the grid. Its display title is derived from the
 * workspace's agent type and the pane's position, unless `name` overrides it. */
export interface Pane {
  id: string;
  /** Per-agent working directory (its own git worktree) when the workspace runs
   * in worktree mode; falls back to the workspace cwd when undefined. */
  cwd?: string;
  /** The agent's git branch, when it runs in a worktree. */
  branch?: string;
  /** Optional custom display name, overriding the derived "Agent N" title. */
  name?: string;
}

/** The id for the pane numbered `seq` — the single mint point, since it's the
 * agent↔`WorktreeRecord` join key and every site must agree. */
export function paneId(seq: number): string {
  return `pane-${seq}`;
}

/**
 * Append an already-formed `pane` (e.g. one whose worktree is provisioned),
 * unless the fleet is already at [`MAX_PANES`]. Pure: returns the same array
 * (unchanged) when at the cap.
 */
export function appendPane(panes: Pane[], pane: Pane): Pane[] {
  if (panes.length >= MAX_PANES) return panes;
  return [...panes, pane];
}

/** Append a new bare pane numbered `seq`, unless already at [`MAX_PANES`]. */
export function addPane(panes: Pane[], seq: number): Pane[] {
  return appendPane(panes, { id: paneId(seq) });
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
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

/** Build `count` panes numbered from `startSeq` (clamped to MAX_PANES). */
export function makePanes(startSeq: number, count: number): Pane[] {
  const n = clampPaneCount(count);
  return Array.from({ length: n }, (_, i) => ({
    id: paneId(startSeq + i),
  }));
}
