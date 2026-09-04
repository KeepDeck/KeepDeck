/**
 * The anchor's CHOICE, PURE on purpose — the half of the correction
 * the library does not own.
 *
 * The library corrects SIZE changes above the viewport by itself;
 * INSERTIONS above are our half, and the choosing of the anchor is a
 * decision, not a side effect: the anchor is the first FULLY VISIBLE
 * row BY KEY (its start ≥ the scroll offset — never the overscan rows
 * above the viewport). A landed WORKSPACE page above a watched
 * other-row shifts the row's INDEX by the page size while its KEY
 * stays — anchoring by index would hold a DIFFERENT row, the exact
 * jump this corrects.
 *
 * The COMPENSATION arithmetic (the delta) is no longer here: the live
 * effect resolves the anchor's index in the FULL queue and asks the
 * library's getOffsetForIndex for its position — measured truth over
 * our own arithmetic, and the stand witnesses it integratively (the
 * full-queue lookup, the sameness invariant) rather than purely.
 *
 * VANISHED KEY — the explicit, named branch in the live effect: when
 * the anchor's key leaves the queue (a real composition change:
 * search, scope, invalidation), the answer is HOLD THE CURRENT
 * OFFSET — whatever now occupies the viewport stays where it is, and
 * the next range change re-anchors on whatever is first visible. A
 * jump to the top would decide for the user in the one moment we
 * ourselves do not know what happened. NOT-YET-MEASURED keys take
 * the same branch: an unmeasured key is the map's youth, not the
 * row's death — treating it as vanished would restore the jump.
 *
 * Extracted PURE so the stand can verify the CHOICE directly —
 * happy-dom computes no geometry, and the DOM half (applying the
 * offset) is the browser's, witnessed by the user, not by this suite.
 */

/** One virtual row as the anchor choice sees it. */
export interface AnchorRow {
  key: string;
  start: number;
}

export type AnchorState = {
  key: string;
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
