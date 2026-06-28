/**
 * Cockpit pane-grid geometry.
 *
 * The cockpit fills a near-square grid row-major. This is the seed of v1's
 * layout templates (1 / 2 / 4 / 6 / 8 panes); named presets grow on top of it.
 */
export interface GridGeometry {
  columns: number;
  rows: number;
}

/**
 * Smallest near-square grid (columns >= rows) that holds `count` panes with the
 * fewest empty cells. Landscape bias keeps terminals readably wide.
 */
export function paneGrid(count: number): GridGeometry {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`pane count must be a positive integer, got ${count}`);
  }
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return { columns, rows };
}

/** CSS `grid-template-*` value spreading `count` equal tracks. */
export function gridTracks(count: number): string {
  return `repeat(${count}, 1fr)`;
}
