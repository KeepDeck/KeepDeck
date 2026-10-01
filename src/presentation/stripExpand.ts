/**
 * The slid-open strip's team lists, decided: which workspace has its list
 * open, and where the list must scroll so an opening list is seen without
 * the row under the pointer ever moving. Pure — the strip's hook holds the
 * state and drives the motion; every number it moves to comes from here.
 */

/** The one workspace whose teams are listed, or null — ONE at a time. */
export type ExpandedTeams = string | null;

export type ExpandEvent =
  /** The strip slid open: the active workspace lists its teams — if it
   * has any to list. */
  | { kind: "open"; activeId: string; activeHasTeams: boolean }
  /** A chevron: open that workspace's list, or close it if it is open. */
  | { kind: "toggle"; wsId: string }
  /** The strip shut, or a drag began: nothing listed. */
  | { kind: "close" };

export function expandTeams(state: ExpandedTeams, event: ExpandEvent): ExpandedTeams {
  switch (event.kind) {
    case "open":
      return event.activeHasTeams ? event.activeId : null;
    case "toggle":
      return state === event.wsId ? null : event.wsId;
    case "close":
      return null;
  }
}

/** Where a row sits in the scrolling list, in the list's own viewport
 * coordinates (0 = the list's visible top). */
export interface RowInList {
  top: number;
  bottom: number;
}

/**
 * The scroll an opening team list needs to be seen: only as far as its
 * bottom overflows, and never so far that its own workspace row leaves the
 * top. Null when it already fits — the list does not move at all.
 */
export function revealScrollTarget(
  scrollTop: number,
  viewportHeight: number,
  row: RowInList,
  listHeight: number,
): number | null {
  const overflow = row.bottom + listHeight - viewportHeight;
  if (overflow <= 0) return null;
  return scrollTop + Math.min(overflow, Math.max(0, row.top));
}

/**
 * The scroll after a list ABOVE the row being opened collapses in one
 * frame: everything below it jumps up by its height, so the scroll moves
 * up by the same amount and the row under the pointer stays put. A list
 * below the row moves nothing above it.
 */
export function scrollAfterInstantCollapse(
  scrollTop: number,
  collapsedHeight: number,
  wasAbove: boolean,
): number {
  return wasAbove ? Math.max(0, scrollTop - collapsedHeight) : scrollTop;
}

/**
 * Where the scroll must end when a list collapses: shrinking content would
 * clamp the scroll in one jump at the end, so the scroll is moved there on
 * the same curve as the collapse. Null when the scroll stays valid.
 */
export function scrollAfterCollapse(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
  collapsingHeight: number,
): number | null {
  const max = Math.max(0, scrollHeight - collapsingHeight - viewportHeight);
  return scrollTop > max ? max : null;
}
