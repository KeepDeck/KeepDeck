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
 * library's measured positions for its start — measured truth over
 * our own arithmetic, and the stand witnesses it integratively (the
 * full-queue lookup, the sameness invariant) rather than purely.
 *
 * VANISHED KEY — the explicit, named branch in the live effect: when
 * the anchor's key leaves the queue (a real composition change:
 * search, scope, invalidation), the answer is HOLD THE CURRENT
 * OFFSET — whatever now occupies the viewport stays where it is, and
 * the anchor moves at once to whatever is now first visible. A
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

/** Where a change of the rows happened, as the item it happened AFTER: the
 * key standing just before the first place the two orders part — a
 * heading whose group opened or shut under it. Null when they part at the
 * very top, or not at all. What a person's own change (a fold) holds in
 * place, instead of the first row in view: the rows it opened go below
 * the heading clicked, never above the viewport where nobody sees them. */
export function changedAfter(before: readonly string[], after: readonly string[]): string | null {
  const length = Math.min(before.length, after.length);
  let at = 0;
  while (at < length && before[at] === after[at]) at++;
  if (at === before.length && at === after.length) return null;
  return at > 0 ? after[at - 1] : null;
}
