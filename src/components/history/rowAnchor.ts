/**
 * The insertion-above anchor correction — PURE, on purpose.
 *
 * The library corrects SIZE changes above the viewport by itself;
 * INSERTIONS above are our half, and the choosing of the anchor is a
 * decision, not a side effect: the anchor is the first FULLY VISIBLE
 * row BY KEY (its start ≥ the scroll offset — never the overscan rows
 * above the viewport), and when the queue gains rows above it, the
 * offset follows so the watched row keeps its place. A landed
 * WORKSPACE page above a watched other-row shifts the row's INDEX by
 * the page size while its KEY stays — anchoring by index would hold a
 * DIFFERENT row, the exact jump this corrects.
 *
 * VANISHED KEY — the explicit, named branch: when the anchor's key
 * leaves the queue (a real composition change: search, scope,
 * invalidation), the answer is HOLD THE CURRENT OFFSET — whatever now
 * occupies the viewport stays where it is (delta 0), and the next
 * call re-anchors on whatever is first visible. A jump to the top
 * would decide for the user in the one moment we ourselves do not
 * know what happened.
 *
 * Extracted PURE so the stand can verify the DECISION arithmetic
 * directly — happy-dom computes no geometry, and the DOM half
 * (applying the delta to scrollTop) is the browser's, witnessed by
 * the user, not by this suite.
 */

/** One virtual row as the correction sees it. */
export interface AnchorRow {
  key: string;
  start: number;
}

export interface AnchorState {
  key: string | null;
  /** The anchor's offset from the scroll top when last seen. */
  offset: number;
}

/** The first fully visible row: its top is at or below the scroll
 * offset. `rows` may arrive in any order; the overscan rows above the
 * viewport are never the anchor. */
export function pickAnchor(
  rows: readonly AnchorRow[],
  scrollTop: number,
): AnchorRow | undefined {
  return [...rows].sort((a, b) => a.start - b.start).find((r) => r.start >= scrollTop);
}

/** The scroll delta that keeps the anchor in place, or the re-anchor
 * when the key vanished (delta 0 by choice — see the header). */
export function anchorCorrection(
  rows: readonly AnchorRow[],
  scrollTop: number,
  prev: AnchorState,
): { delta: number; next: AnchorState } {
  const at = rows.find((r) => r.key === prev.key);
  if (at) {
    return {
      delta: at.start - scrollTop - prev.offset,
      next: prev,
    };
  }
  // Vanished: hold the offset, re-anchor on the first visible row.
  const first = pickAnchor(rows, scrollTop);
  return {
    delta: 0,
    next: {
      key: first ? first.key : null,
      offset: first ? first.start - scrollTop : 0,
    },
  };
}
