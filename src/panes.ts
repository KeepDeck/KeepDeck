import { MAX_PANES } from "./layout";

/** One agent pane in the grid. */
export interface Pane {
  id: string;
  title: string;
}

/**
 * Append a new pane numbered `seq`, unless the fleet is already at
 * [`MAX_PANES`]. Pure: returns the same array (unchanged) when at the cap.
 */
export function addPane(panes: Pane[], seq: number): Pane[] {
  if (panes.length >= MAX_PANES) return panes;
  return [...panes, { id: `pane-${seq}`, title: `agent-${seq}` }];
}

/** Remove the pane with `id`; a no-op if it isn't present. */
export function removePane(panes: Pane[], id: string): Pane[] {
  return panes.filter((pane) => pane.id !== id);
}
