import { MAX_PANES } from "./layout";

/** One agent pane in the grid. Its display title is derived from the
 * workspace's agent type and the pane's position, not stored here. */
export interface Pane {
  id: string;
}

/**
 * Append a new pane numbered `seq`, unless the fleet is already at
 * [`MAX_PANES`]. Pure: returns the same array (unchanged) when at the cap.
 */
export function addPane(panes: Pane[], seq: number): Pane[] {
  if (panes.length >= MAX_PANES) return panes;
  return [...panes, { id: `pane-${seq}` }];
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
}

/** Build `count` panes numbered from `startSeq` (clamped to MAX_PANES). */
export function makePanes(startSeq: number, count: number): Pane[] {
  const n = Math.max(0, Math.min(count, MAX_PANES));
  return Array.from({ length: n }, (_, i) => ({
    id: `pane-${startSeq + i}`,
  }));
}
