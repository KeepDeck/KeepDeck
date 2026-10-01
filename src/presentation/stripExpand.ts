/**
 * The slid-open strip's team lists, decided: which workspace has its list
 * open, and where the list must scroll so an opening list is seen without
 * the row under the pointer ever moving. Pure — the strip's hook holds the
 * state and drives the motion; every number it moves to comes from here.
 */

import { STRIP_WORDS, type WorkspaceMark } from "./stripView";

/** The chevron beside a workspace in the slid-open strip, decided: none
 * for a workspace without teams; otherwise its words, and the count it
 * shows while its list is closed (an open list counts itself). */
export function teamsToggleView(
  mark: Pick<WorkspaceMark, "name" | "teams">,
  expanded: boolean,
): { label: string; count: string | null } | null {
  if (mark.teams.length === 0) return null;
  return {
    label: expanded ? STRIP_WORDS.hideTeams(mark.name) : STRIP_WORDS.showTeams(mark.name),
    count: expanded ? null : STRIP_WORDS.teamCount(mark.teams.length),
  };
}

/** Which team lists the strip holds: the ONE listed workspace, and one
 * whose list is still folding away (drawn until its collapse ends). */
export interface ExpandedTeams {
  expanded: string | null;
  leaving: string | null;
}

export const NOTHING_LISTED: ExpandedTeams = { expanded: null, leaving: null };

export type ExpandEvent =
  /** The strip slid open: the active workspace lists its teams — if it
   * has any to list. */
  | { kind: "open"; activeId: string; activeHasTeams: boolean }
  /** A chevron: open that workspace's list, or fold it if it is open.
   * Moving to ANOTHER workspace drops the old list at once — two lists
   * moving together would shift the row under the pointer. */
  | { kind: "toggle"; wsId: string }
  /** The strip shut (the list folds away with it), or a drag began
   * (`instant`: the column must hold still under the grab). */
  | { kind: "close"; instant?: boolean }
  /** The folding list finished. */
  | { kind: "settled" };

export function expandTeams(state: ExpandedTeams, event: ExpandEvent): ExpandedTeams {
  switch (event.kind) {
    case "open":
      return { expanded: event.activeHasTeams ? event.activeId : null, leaving: null };
    case "toggle":
      return state.expanded === event.wsId
        ? { expanded: null, leaving: event.wsId }
        : { expanded: event.wsId, leaving: null };
    case "close":
      return event.instant || state.expanded === null
        ? { expanded: null, leaving: event.instant ? null : state.leaving }
        : { expanded: null, leaving: state.expanded };
    case "settled":
      return { ...state, leaving: null };
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

/**
 * The scroll that brings a row into the column's view — the active mark,
 * when the workspace changes while the strip is shut: by the least
 * distance, from whichever edge it is past. Null when it is in view.
 */
export function scrollToShow(scrollTop: number, viewportHeight: number, row: RowInList): number | null {
  if (row.top < 0) return Math.max(0, scrollTop + row.top);
  if (row.bottom > viewportHeight) return scrollTop + row.bottom - viewportHeight;
  return null;
}
