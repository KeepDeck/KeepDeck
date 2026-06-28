/** Max agents the cockpit grid holds at once — a hard product cap. */
export const MAX_PANES = 16;

/** Geometry of the cockpit grid: a square-ish column count, filled row by row. */
export interface GridGeometry {
  columns: number;
  rows: number;
}

/**
 * Cockpit grid geometry for `count` panes (`1..=MAX_PANES`). The column count is
 * square-driven (`⌈√count⌉`) so the grid stays roughly square, and the row count
 * is only as many as needed to hold the panes (`⌈count / columns⌉`) — so there
 * are no empty trailing rows and the grid shrinks as panes are closed.
 */
export function paneGrid(count: number): GridGeometry {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PANES) {
    throw new RangeError(
      `pane count must be an integer in 1..=${MAX_PANES}, got ${count}`,
    );
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return { columns, rows };
}

/** CSS `grid-template-*` value spreading `count` equal tracks. */
export function gridTracks(count: number): string {
  return `repeat(${count}, 1fr)`;
}
