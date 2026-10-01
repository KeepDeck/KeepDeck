import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import {
  NOTHING_LISTED,
  expandTeams,
  revealScrollTarget,
  scrollAfterCollapse,
  scrollAfterInstantCollapse,
  scrollToShow,
} from "../../presentation/stripExpand";
import type { StripView } from "../../presentation/stripView";
import {
  STRIP_MOTION_MS,
  animateTeamList,
  browserClock,
  prefersReducedMotion,
  type MotionHandle,
} from "../../app/stripTeamsMotion";

/** The id a workspace's team list carries — what the chevron controls and
 * what the motion finds. */
export const stripTeamsId = (wsId: string) => `strip-teams-${wsId}`;

/**
 * The slid-open strip's team lists: which one is listed (`expandTeams`
 * decides) and how it moves. Opening lists the active workspace's teams;
 * shutting folds the list away with the strip, or drops it at once when a
 * drag began; a chevron moves the one list.
 *
 * Every list motion runs height and scroll on one curve
 * (`animateTeamList`), to the numbers `stripExpand` computes — the row a
 * list hangs from never moves on its own. Moving the list to another
 * workspace drops the old one in the same frame, with the scroll moved by
 * its height when it was above, so the row under the pointer holds still.
 */
export function useStripTeams(
  open: boolean,
  /** The mark a drag holds, or null: while one is held, the list drops at
   * once — and gives its height back to the scroll if it hung above the
   * held mark, so the mark stays under the hand. */
  dragged: string | null,
  view: StripView,
  listRef: RefObject<HTMLElement | null>,
) {
  const [state, dispatch] = useReducer(expandTeams, NOTHING_LISTED);
  const active = view.marks.find((mark) => mark.active);

  useEffect(() => {
    dispatch(
      open
        ? { kind: "open", activeId: active?.id ?? "", activeHasTeams: (active?.teams.length ?? 0) > 0 }
        : { kind: "close", instant: dragged !== null },
    );
    // Only the strip opening or shutting re-decides: the active mark's
    // teams changing under an open strip must not yank a list the person
    // moved elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const before = useRef(NOTHING_LISTED);
  /** Each list's full height, as last measured opening — what an instant
   * drop has to give back to the scroll. */
  const heights = useRef(new Map<string, number>());
  const motion = useRef<MotionHandle | null>(null);
  const order = view.marks.map((mark) => mark.id);

  useLayoutEffect(() => {
    const list = listRef.current;
    const was = before.current;
    before.current = state;
    if (!list) return;
    const block = (id: string) => document.getElementById(stripTeamsId(id));
    const durationMs = prefersReducedMotion() ? 0 : STRIP_MOTION_MS;

    // The old list dropped outright (moved elsewhere, or a drag began):
    // give its height back to the scroll if it hung above the new one.
    if (was.expanded !== null && was.expanded !== state.expanded && state.leaving !== was.expanded) {
      motion.current?.stop();
      // Kept still: the row now listed, or the mark a drag just took hold of.
      const kept = state.expanded ?? dragged;
      if (kept !== null) {
        const above = order.indexOf(was.expanded) < order.indexOf(kept);
        list.scrollTop = scrollAfterInstantCollapse(
          list.scrollTop,
          heights.current.get(was.expanded) ?? 0,
          above,
        );
      }
    }

    if (state.expanded !== null && state.expanded !== was.expanded) {
      const el = block(state.expanded);
      if (!el) return;
      const full = el.scrollHeight;
      heights.current.set(state.expanded, full);
      const head = el.previousElementSibling ?? el;
      const listBox = list.getBoundingClientRect();
      const row = head.getBoundingClientRect();
      motion.current = animateTeamList(
        {
          block: el,
          list,
          from: 0,
          to: full,
          scrollTo: revealScrollTarget(
            list.scrollTop,
            list.clientHeight,
            { top: row.top - listBox.top, bottom: row.bottom - listBox.top },
            full,
          ),
          durationMs,
        },
        browserClock,
        // Settled: back to its natural height, so a team added or gone
        // while it is open simply grows or shrinks it.
        () => {
          el.style.height = "";
        },
      );
    } else if (state.leaving !== null && state.leaving !== was.leaving) {
      motion.current?.stop();
      const el = block(state.leaving);
      if (!el) {
        dispatch({ kind: "settled" });
        return;
      }
      const from = el.offsetHeight;
      motion.current = animateTeamList(
        {
          block: el,
          list,
          from,
          to: 0,
          scrollTo: scrollAfterCollapse(list.scrollTop, list.scrollHeight, list.clientHeight, from),
          durationMs,
        },
        browserClock,
        () => dispatch({ kind: "settled" }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.expanded, state.leaving]);

  // At rest the column shows the workspace on screen: when the active one
  // changes (a hotkey, a notification, the crumb) and its mark is scrolled
  // out of the column, bring it in. Not while open — the person is reading
  // it — and not under a drag, which owns the column then.
  const activeId = active?.id ?? null;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || open || dragged !== null || activeId === null) return;
    const mark = [...list.querySelectorAll<HTMLElement>("[data-ws-id]")].find(
      (el) => el.dataset.wsId === activeId,
    );
    if (!mark) return;
    const listBox = list.getBoundingClientRect();
    const row = mark.getBoundingClientRect();
    const target = scrollToShow(list.scrollTop, list.clientHeight, {
      top: row.top - listBox.top,
      bottom: row.top - listBox.top + mark.offsetHeight,
    });
    if (target !== null) list.scrollTop = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // A person scrolling takes over: the motion lands at once rather than
  // keep writing a scroll under the wheel.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const takeOver = () => motion.current?.finish();
    list.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      list.removeEventListener("wheel", takeOver);
      motion.current?.stop();
    };
  }, [listRef]);

  return {
    /** The workspace listed, and one still folding away — both drawn. */
    expanded: state.expanded,
    leaving: state.leaving,
    toggle: (wsId: string) => dispatch({ kind: "toggle", wsId }),
  };
}
