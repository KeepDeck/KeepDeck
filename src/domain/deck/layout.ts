/** Max agents ONE TEAM holds at once — a hard product cap, measured where
 * a pane joins a team. A workspace holds as many teams as it likes. */
export const MAX_PANES = 16;

/** The error thrown when a pane can't join because its team is at
 * `MAX_PANES` — one string for every add/fork/resume seam that guards the cap. */
export const TEAM_FULL_MESSAGE =
  `The team is full — ${MAX_PANES} agents; close one first`;

/** The error when the workspace a pane was headed for is no longer in the
 * deck — every add re-resolves against the live store, and a close can land
 * inside the awaits a worktree create or a fork's surgery needs. One string
 * for the same reason the cap has one: it was already spelled two ways. */
export const WORKSPACE_GONE_MESSAGE = "That workspace was closed.";
/** A directory a team already holds, where the request cannot join it: a
 * create heading for a directory some team runs in (a worktree cannot be
 * made where one is), or a directory a team in ANOTHER workspace holds —
 * one directory is one team's, and a team never spans workspaces. */
export const WORKTREE_HELD_MESSAGE = "That directory is already a team's.";

/** Geometry of the deck grid: a square-ish column count, filled row by row. */
export interface GridGeometry {
  columns: number;
  rows: number;
}

/**
 * Deck grid geometry for `count` panes (`1..=MAX_PANES`). The column count is
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
 * CSS column-track count for `count` panes: the least common multiple of the
 * conceptual columns and the last row's pane count, so EVERY row can divide its
 * width into equal panes (e.g. a 2-pane last row under 3 columns needs 6 tracks
 * so each last-row pane spans 3 = exactly half).
 */
export function paneGridTrackColumns(count: number): number {
  const { columns, rows } = paneGrid(count);
  const lastRowCount = count - columns * (rows - 1);
  return lcm(columns, lastRowCount);
}

/**
 * How many CSS column tracks the pane at `index` (row-major, 0-based) spans.
 * Panes in the same row get the SAME span (equal width); a row's spans always
 * sum to [`paneGridTrackColumns`], so an incomplete last row fills the full
 * width with equal-width panes and no gaps.
 */
export function paneColumnSpan(index: number, count: number): number {
  const { columns, rows } = paneGrid(count);
  const lastRowStart = columns * (rows - 1);
  const lastRowCount = count - lastRowStart;
  // The track count MUST come from the same formula the grid template uses —
  // spans divide it exactly, so a drifted copy would misalign every
  // non-square grid.
  const total = paneGridTrackColumns(count);
  return index < lastRowStart ? total / columns : total / lastRowCount;
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}
