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

/**
 * How many columns the pane at `index` (row-major, 0-based) should span so an
 * incomplete row fills the full width with no gaps. Every row but the last is
 * full (span 1 each); the last row's panes share its columns as evenly as
 * possible, the leftmost taking any remainder.
 */
export function paneColumnSpan(index: number, count: number): number {
  const { columns, rows } = paneGrid(count);
  const lastRowStart = columns * (rows - 1);
  if (index < lastRowStart) return 1;

  const lastRowCount = count - lastRowStart;
  const base = Math.floor(columns / lastRowCount);
  const remainder = columns % lastRowCount;
  const positionInRow = index - lastRowStart;
  return base + (positionInRow < remainder ? 1 : 0);
}
