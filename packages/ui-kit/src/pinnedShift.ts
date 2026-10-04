/** One mounted row as the pinned heading's push sees it. */
export interface PinnedRow {
  index: number;
  start: number;
}

/**
 * How far the pinned heading is pushed up, in pixels (zero or less): the
 * next group's heading, rising to the top edge, shoves the pinned one out
 * ahead of it — by exactly the part it has run into — so the two never
 * overlap, and the moment the next one reaches the top the pinned one is
 * gone past it. Read from the scroll, not timed: it moves with the finger.
 *
 * `first` is the first row in view (whose group the pinned heading heads);
 * the next heading is the first row after it that `heads` says starts a
 * group. None in the window: nothing pushes.
 */
export function pinnedShift(
  rows: readonly PinnedRow[],
  first: number,
  scrollTop: number,
  height: number,
  heads: (index: number) => boolean,
): number {
  const next = rows.find((row) => row.index > first && heads(row.index));
  if (!next) return 0;
  return Math.min(0, next.start - scrollTop - height);
}
