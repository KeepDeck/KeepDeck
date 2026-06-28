/** Max agents the cockpit grid holds at once — a hard product cap. */
export const MAX_PANES = 16;

/** Geometry of the (always square) cockpit grid. `columns === rows`. */
export interface GridGeometry {
  columns: number;
  rows: number;
}

/**
 * The cockpit agent grid is ALWAYS SQUARE. Returns the smallest square that
 * holds `count` panes — `columns === rows === ⌈√count⌉` — for `count` in
 * `1..=MAX_PANES`. Panes fill row-major; any cells beyond `count` stay empty.
 */
export function paneGrid(count: number): GridGeometry {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PANES) {
    throw new RangeError(
      `pane count must be an integer in 1..=${MAX_PANES}, got ${count}`,
    );
  }
  const side = Math.ceil(Math.sqrt(count));
  return { columns: side, rows: side };
}

/** CSS `grid-template-*` value spreading `count` equal tracks. */
export function gridTracks(count: number): string {
  return `repeat(${count}, 1fr)`;
}
