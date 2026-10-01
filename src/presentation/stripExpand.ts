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
    count: expanded ? null : String(mark.teams.length),
  };
}

/** Which team lists the strip holds: every workspace listed now, every one
 * still folding away (drawn until its fold ends), and the ones the person
 * had open when the strip last shut — they open again with it. Any number
 * of each: the person opens and closes lists freely (user decision). */
export interface ExpandedTeams {
  expanded: readonly string[];
  leaving: readonly string[];
  kept: readonly string[];
  /** A workspace being dragged whose list was open: folded out of the way
   * for the drag, reopened where it lands. */
  held: string | null;
}

export const NOTHING_LISTED: ExpandedTeams = { expanded: [], leaving: [], kept: [], held: null };

export type ExpandEvent =
  /** The strip slid open: the lists the person kept open, and the active
   * workspace's — if it has teams to list. */
  | { kind: "open"; activeId: string; activeHasTeams: boolean }
  /** A chevron: open that workspace's list, or fold it if it is open. */
  | { kind: "toggle"; wsId: string }
  /** The strip shut: the lists fold away with it. */
  | { kind: "close" }
  /** A folding list finished. */
  | { kind: "settled"; wsId: string }
  /** A drag took hold of a workspace: its own list leaves AT ONCE, so the
   * drag carries a mark, not a mark and a hole the height of its teams. */
  | { kind: "hold"; wsId: string }
  /** The drag let go: the held workspace's list opens again. */
  | { kind: "release" };

const without = (ids: readonly string[], id: string) => ids.filter((each) => each !== id);
const union = (a: readonly string[], b: readonly string[]) => [...a, ...b.filter((id) => !a.includes(id))];

export function expandTeams(state: ExpandedTeams, event: ExpandEvent): ExpandedTeams {
  switch (event.kind) {
    case "open":
      return {
        expanded: union(state.kept, event.activeHasTeams ? [event.activeId] : []),
        leaving: [],
        kept: state.kept,
        held: null,
      };
    case "toggle":
      return state.expanded.includes(event.wsId)
        ? {
            ...state,
            expanded: without(state.expanded, event.wsId),
            leaving: union(state.leaving, [event.wsId]),
          }
        : {
            ...state,
            expanded: [...state.expanded, event.wsId],
            leaving: without(state.leaving, event.wsId),
          };
    case "close":
      return {
        expanded: [],
        leaving: union(state.leaving, state.expanded),
        kept: state.held === null ? state.expanded : union(state.expanded, [state.held]),
        held: null,
      };
    case "settled":
      return { ...state, leaving: without(state.leaving, event.wsId) };
    case "hold":
      return state.expanded.includes(event.wsId)
        ? { ...state, expanded: without(state.expanded, event.wsId), held: event.wsId }
        : state;
    case "release":
      return state.held === null
        ? state
        : { ...state, expanded: union(state.expanded, [state.held]), held: null };
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
