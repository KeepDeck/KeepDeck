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

  // Before paint: the strip's first open frame already holds its list,
  // so the edge and the list start together instead of a frame apart.
  useLayoutEffect(() => {
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
  /** Each list's height as it stands — kept current every frame of its
   * motion and every commit at rest, so a list dropped outright (moved
   * elsewhere, a drag, cut off mid-fold) gives back to the scroll exactly
   * what it took. */
  const heights = useRef(new Map<string, number>());
  const motion = useRef<MotionHandle | null>(null);
  const moving = useRef(false);
  const order = view.marks.map((mark) => mark.id);

  /** The list's box, with every height the motion writes recorded. */
  const tracked = (id: string, el: HTMLElement) => ({
    style: {
      set height(value: string) {
        el.style.height = value;
        heights.current.set(id, parseFloat(value) || 0);
      },
      get height() {
        return el.style.height;
      },
    },
  });
  const stopMotion = () => {
    motion.current?.stop();
    moving.current = false;
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    const was = before.current;
    before.current = state;
    if (!list) return;
    const block = (id: string) => document.getElementById(stripTeamsId(id));
    const durationMs = prefersReducedMotion() ? 0 : STRIP_MOTION_MS;

    // Lists that VANISHED this commit — the listed one moved elsewhere or
    // dropped for a drag, or a folding one cut off mid-fold — give the
    // height they had back to the scroll when they hung above what stays
    // still: the row now listed, or the mark a drag just took hold of.
    const vanished = [was.expanded, was.leaving].filter(
      (id): id is string => id !== null && id !== state.expanded && id !== state.leaving,
    );
    if (vanished.length > 0) {
      stopMotion();
      const kept = state.expanded ?? dragged;
      for (const id of vanished) {
        if (kept !== null) {
          list.scrollTop = scrollAfterInstantCollapse(
            list.scrollTop,
            heights.current.get(id) ?? 0,
            order.indexOf(id) < order.indexOf(kept),
          );
        }
        heights.current.delete(id);
      }
    }

    if (state.expanded !== null && state.expanded !== was.expanded) {
      stopMotion();
      const id = state.expanded;
      const el = block(id);
      if (!el) return;
      // A list caught mid-fold opens from the height it reached, not from
      // nothing — reopening under the pointer must not snap it shut first.
      const reached = el.style.height === "" ? 0 : parseFloat(el.style.height) || 0;
      el.style.height = "auto";
      const full = el.scrollHeight;
      el.style.height = `${reached}px`;
      const head = el.previousElementSibling ?? el;
      const listBox = list.getBoundingClientRect();
      const row = head.getBoundingClientRect();
      moving.current = true;
      motion.current = animateTeamList(
        {
          block: tracked(id, el),
          list,
          from: reached,
          to: full,
          scrollTo: revealScrollTarget(
            list.scrollTop,
            list.clientHeight,
            { top: row.top - listBox.top, bottom: row.bottom - listBox.top },
            full - reached,
          ),
          durationMs,
        },
        browserClock,
        // Settled: back to its natural height, so a team added or gone
        // while it is open simply grows or shrinks it.
        () => {
          moving.current = false;
          el.style.height = "";
        },
      );
    } else if (state.leaving !== null && state.leaving !== was.leaving) {
      stopMotion();
      const id = state.leaving;
      const el = block(id);
      if (!el) {
        dispatch({ kind: "settled" });
        return;
      }
      const from = el.offsetHeight;
      moving.current = true;
      motion.current = animateTeamList(
        {
          block: tracked(id, el),
          list,
          from,
          to: 0,
          scrollTo: scrollAfterCollapse(list.scrollTop, list.scrollHeight, list.clientHeight, from),
          durationMs,
        },
        browserClock,
        () => {
          moving.current = false;
          dispatch({ kind: "settled" });
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.expanded, state.leaving]);

  // At rest, a listed team list follows its teams (one added while open):
  // keep its recorded height true for a later drop.
  useLayoutEffect(() => {
    if (moving.current || state.expanded === null) return;
    const el = document.getElementById(stripTeamsId(state.expanded));
    if (el) heights.current.set(state.expanded, el.offsetHeight);
  });

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
    const takeOver = () => {
      motion.current?.finish();
      moving.current = false;
    };
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
