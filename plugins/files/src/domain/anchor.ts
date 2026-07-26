/**
 * Where the reader is in a list of rows, as a row index — the pure half of
 * holding someone's place while the rows are re-laid-out under them. The
 * caller reads the geometry; this decides what it means.
 */

/**
 * The first row still on screen. `bottom > viewportTop` keeps the row that is
 * only partly scrolled off, since that is the one being read rather than the
 * first one fully below the fold.
 *
 * When no row's bottom clears the viewport, every row ends above it — the
 * reader is past the last one, so the LAST row is their place. Answering with
 * the first would send them from the end of the file to its start.
 */
export function rowAtViewportTop(
  rowBottoms: number[],
  viewportTop: number,
): number {
  const seen = rowBottoms.findIndex((bottom) => bottom > viewportTop);
  return seen === -1 ? Math.max(0, rowBottoms.length - 1) : seen;
}
