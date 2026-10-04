/** One mounted row as the pinned heading sees it. */
export interface PinnedRow {
  index: number;
  start: number;
  end: number;
}

/** What the pinned heading shows, and where. */
export interface PinnedFrame {
  /** The first row any part of which is in view — whose group the pinned
   * heading heads; -1 when no mounted row is in view. */
  first: number;
  /** How far it is pushed up, in pixels (zero or less). */
  shift: number;
}

/**
 * The pinned heading at a scroll offset. The next group's heading, rising
 * to the top edge, shoves the pinned one out ahead of it — by exactly the
 * part it has run into — so the two never overlap, and the moment the
 * next one reaches the top the pinned one is gone past it.
 *
 * The next heading is the first row after `first` that `heads` says
 * starts a group; none among the mounted rows, nothing pushes. `rows` in
 * index order, as the window mounts them.
 */
export function pinnedFrame(
  rows: readonly PinnedRow[],
  scrollTop: number,
  height: number,
  heads: (index: number) => boolean,
): PinnedFrame {
  const first = rows.find((row) => row.end > scrollTop);
  if (!first) return { first: -1, shift: 0 };
  const next = rows.find((row) => row.index > first.index && heads(row.index));
  return { first: first.index, shift: next ? Math.min(0, next.start - scrollTop - height) : 0 };
}
