/**
 * The slid-open strip's team lists, decided: which workspaces have their
 * lists open (any number), which are folding, which the strip keeps for
 * its next open and which a drag holds — and where the column must scroll
 * so an opening list is seen. Pure — the strip's hook holds the
 * state and drives the motion; every number it moves to comes from here.
 */

import { STRIP_WORDS, type WorkspaceMark } from "./stripView";

/** The chevron beside a workspace in the slid-open strip, decided: none
 * for a workspace without teams; otherwise its words, the count it shows
 * while its list is closed (an open list counts itself), and whether it can
 * be reached — past the shut edge it is out of sight, so out of reach. */
export function teamsToggleView(
  mark: Pick<WorkspaceMark, "name" | "teams">,
  expanded: boolean,
  stripOpen: boolean,
): { label: string; count: string | null; expanded: boolean; reachable: boolean } | null {
  if (mark.teams.length === 0) return null;
  return {
    label: expanded ? STRIP_WORDS.hideTeams(mark.name) : STRIP_WORDS.showTeams(mark.name),
    count: expanded ? null : String(mark.teams.length),
    expanded,
    reachable: stripOpen,
  };
}

/** One workspace's group in the column, decided: whether its row is the
 * empty slot a drag left (its mark rides as the ghost), whether its team
 * list is drawn — only while open or folding, and never for a workspace
 * left with no teams to list — and its chevron. */
export function stripGroupView(
  mark: Pick<WorkspaceMark, "id" | "name" | "teams">,
  lists: { expanded: boolean; drawn: boolean },
  strip: { open: boolean; draggedId: string | null },
) {
  return {
    placeholder: mark.id === strip.draggedId,
    listDrawn: lists.drawn && mark.teams.length > 0,
    toggle: teamsToggleView(mark, lists.expanded, strip.open),
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
   * workspace's — each only if it still has teams to list (`listable`): a
   * workspace gone, or emptied of teams, has no list to bring back. */
  | { kind: "open"; activeId: string; listable: readonly string[] }
  /** A chevron: open that workspace's list, or fold it if it is open. */
  | { kind: "toggle"; wsId: string }
  /** The strip shut: the lists fold away with it. */
  | { kind: "close" }
  /** A folding list finished. */
  | { kind: "settled"; wsId: string }
  /** A drag took hold of a workspace: its own list folds away, as a
   * chevron would fold it, so the drag carries a mark, not a mark and a
   * hole the height of its teams. ONE hold at a time: a drag is one
   * pointer, so a second hold cannot arrive before its release — a
   * multi-pointer drag would have to hold a set, or orphan `held`. */
  | { kind: "hold"; wsId: string }
  /** The drag let go: the held workspace's list opens again. */
  | { kind: "release" };

const without = (ids: readonly string[], id: string) => ids.filter((each) => each !== id);
const union = (a: readonly string[], b: readonly string[]) => [...a, ...b.filter((id) => !a.includes(id))];

export function expandTeams(state: ExpandedTeams, event: ExpandEvent): ExpandedTeams {
  switch (event.kind) {
    case "open": {
      const kept = state.kept.filter((id) => event.listable.includes(id));
      return {
        expanded: union(kept, event.listable.includes(event.activeId) ? [event.activeId] : []),
        leaving: [],
        kept,
        held: null,
      };
    }
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
        ? {
            ...state,
            expanded: without(state.expanded, event.wsId),
            leaving: union(state.leaving, [event.wsId]),
            held: event.wsId,
          }
        : state;
    case "release":
      return state.held === null
        ? state
        : {
            ...state,
            expanded: union(state.expanded, [state.held]),
            leaving: without(state.leaving, state.held),
            held: null,
          };
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
 *
 * `growthAbove`: how much OTHER lists opening on the same frames will grow
 * above the row — they push it down by that much by the time it lands (the
 * strip opening with several kept lists).
 */
export function revealScrollTarget(
  scrollTop: number,
  viewportHeight: number,
  row: RowInList,
  listHeight: number,
  growthAbove = 0,
): number | null {
  const landed = { top: row.top + growthAbove, bottom: row.bottom + growthAbove };
  const overflow = landed.bottom + listHeight - viewportHeight;
  if (overflow <= 0) return null;
  return scrollTop + Math.min(overflow, Math.max(0, landed.top));
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

/** Which lists start a motion this commit: newly listed ones open, newly
 * folding ones fold. A list that merely stays listed does not move. */
export function listChanges(was: ExpandedTeams, now: ExpandedTeams) {
  return {
    opened: now.expanded.filter((id) => !was.expanded.includes(id)),
    folding: now.leaving.filter((id) => !was.leaving.includes(id)),
  };
}

/** An opening list as measured: the height it starts from (what a fold
 * left it, or 0), its full height, and its workspace's row in the column. */
export interface OpeningList {
  id: string;
  reached: number;
  full: number;
  row: RowInList;
}

/** A folding list as measured: the height it folds from. */
export interface FoldingList {
  id: string;
  height: number;
}

export interface ColumnGeometry {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
}

/** One list's motion: its height from → to, and where it carries the
 * scroll — or null, as all but one motion must leave the scroll alone. */
export interface ListMotionPlan {
  id: string;
  from: number;
  to: number;
  scrollTo: number | null;
}

/**
 * The commit's list motions, decided. ONE of them may carry the scroll: an
 * opening list the person just asked for (a chevron), or the active
 * workspace's when the strip opens with several; failing an opener that
 * scrolls, the first fold carries the clamp the folds' combined loss will
 * cause. An opener's target counts the lists opening ABOVE it on the same
 * frames (deck order), which push its row down by the time it lands.
 */
export function planListMotions(
  opening: readonly OpeningList[],
  folding: readonly FoldingList[],
  activeId: string | null,
  deckOrder: readonly string[],
  column: ColumnGeometry,
): ListMotionPlan[] {
  const owner =
    opening.length === 1 ? opening[0].id : opening.find((list) => list.id === activeId)?.id ?? null;
  const opens = opening.map((list): ListMotionPlan => {
    if (list.id !== owner) return { id: list.id, from: list.reached, to: list.full, scrollTo: null };
    const growthAbove = opening
      .filter((other) => deckOrder.indexOf(other.id) < deckOrder.indexOf(list.id))
      .reduce((sum, other) => sum + other.full - other.reached, 0);
    return {
      id: list.id,
      from: list.reached,
      to: list.full,
      scrollTo: revealScrollTarget(
        column.scrollTop,
        column.viewportHeight,
        list.row,
        list.full - list.reached,
        growthAbove,
      ),
    };
  });
  const openerScrolls = opens.some((plan) => plan.scrollTo !== null);
  const loss = folding.reduce((sum, list) => sum + list.height, 0);
  const foldScroll = openerScrolls
    ? null
    : scrollAfterCollapse(column.scrollTop, column.contentHeight, column.viewportHeight, loss);
  const folds = folding.map(
    (list, index): ListMotionPlan => ({
      id: list.id,
      from: list.height,
      to: 0,
      scrollTo: index === 0 ? foldScroll : null,
    }),
  );
  return [...opens, ...folds];
}
