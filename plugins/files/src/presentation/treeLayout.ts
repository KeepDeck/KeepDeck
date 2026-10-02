/** A tree row's first-paint height guess, before it is measured: a line
 * of the row's 11px type at line-height 1.4, in 3px padding top and bottom
 * (`.files__row` in styles.css — its test reads the sheet and goes red
 * when one changes without the other). */
export const TREE_ROW_ESTIMATE_PX = 22;

/** How many rows a PageUp/PageDown moves the cursor: the rows the tree's
 * box shows, at least one. */
export function rowsPerPage(boxHeight: number): number {
  return Math.max(1, Math.floor(boxHeight / TREE_ROW_ESTIMATE_PX));
}
