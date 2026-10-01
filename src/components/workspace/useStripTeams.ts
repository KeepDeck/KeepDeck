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
 * The slid-open strip's team lists: which are listed (`expandTeams`
 * decides) and how they move. Opening lists the active workspace's teams
 * and the ones kept open last time; a chevron opens or folds any list;
 * shutting folds them away with the strip, or drops them at once when a
 * drag began.
 *
 * Every list motion runs height and scroll on one curve
 * (`animateTeamList`), to the numbers `stripExpand` computes — the row a
 * list hangs from never moves on its own, and only one motion at a time
 * drives the scroll.
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
   * motion and every commit at rest, so a list dropped outright (a drag)
   * gives back to the scroll exactly what it took. */
  const heights = useRef(new Map<string, number>());
  /** One running motion per list: lists open and fold independently. */
  const motions = useRef(new Map<string, MotionHandle>());
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
  const stopMotion = (id: string) => {
    motions.current.get(id)?.stop();
    motions.current.delete(id);
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    const was = before.current;
    before.current = state;
    if (!list) return;
    const block = (id: string) => document.getElementById(stripTeamsId(id));
    const durationMs = prefersReducedMotion() ? 0 : STRIP_MOTION_MS;
    const drawn = (s: typeof state) => [...s.expanded, ...s.leaving];

    // Lists that VANISHED this commit (a drag dropped them outright) give
    // back to the scroll the height they had above the mark a drag holds,
    // so that mark stays under the hand.
    const vanished = drawn(was).filter((id) => !drawn(state).includes(id));
    if (vanished.length > 0) {
      for (const id of vanished) {
        stopMotion(id);
        if (dragged !== null) {
          list.scrollTop = scrollAfterInstantCollapse(
            list.scrollTop,
            heights.current.get(id) ?? 0,
            order.indexOf(id) < order.indexOf(dragged),
          );
        }
        heights.current.delete(id);
      }
    }

    // Lists newly opened. Only ONE motion may drive the scroll: the list
    // the person just asked for (a chevron), or the active workspace's
    // when the strip opens.
    const opened = state.expanded.filter((id) => !was.expanded.includes(id));
    const scrollOwner =
      opened.length === 1 ? opened[0] : opened.find((id) => id === active?.id) ?? null;
    for (const id of opened) {
      stopMotion(id);
      const el = block(id);
      if (!el) continue;
      // A list caught mid-fold opens from the height it reached, not from
      // nothing — reopening under the pointer must not snap it shut first.
      const reached = el.style.height === "" ? 0 : parseFloat(el.style.height) || 0;
      el.style.height = "auto";
      const full = el.scrollHeight;
      el.style.height = `${reached}px`;
      const head = el.previousElementSibling ?? el;
      const listBox = list.getBoundingClientRect();
      const row = head.getBoundingClientRect();
      motions.current.set(
        id,
        animateTeamList(
          {
            block: tracked(id, el),
            list,
            from: reached,
            to: full,
            scrollTo:
              id === scrollOwner
                ? revealScrollTarget(
                    list.scrollTop,
                    list.clientHeight,
                    { top: row.top - listBox.top, bottom: row.bottom - listBox.top },
                    full - reached,
                  )
                : null,
            durationMs,
          },
          browserClock,
          // Settled: back to its natural height, so a team added or gone
          // while it is open simply grows or shrinks it.
          () => {
            motions.current.delete(id);
            el.style.height = "";
          },
        ),
      );
    }

    // Lists newly folding. Their combined loss may clamp the scroll; ONE
    // of them carries the scroll there on the shared curve.
    const folding = state.leaving.filter((id) => !was.leaving.includes(id));
    const elements = folding.map((id) => [id, block(id)] as const);
    const loss = elements.reduce((sum, [, el]) => sum + (el?.offsetHeight ?? 0), 0);
    const foldScroll = scrollAfterCollapse(list.scrollTop, list.scrollHeight, list.clientHeight, loss);
    elements.forEach(([id, el], index) => {
      stopMotion(id);
      if (!el) {
        dispatch({ kind: "settled", wsId: id });
        return;
      }
      motions.current.set(
        id,
        animateTeamList(
          {
            block: tracked(id, el),
            list,
            from: el.offsetHeight,
            to: 0,
            scrollTo: index === 0 ? foldScroll : null,
            durationMs,
          },
          browserClock,
          () => {
            motions.current.delete(id);
            dispatch({ kind: "settled", wsId: id });
          },
        ),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.expanded, state.leaving]);

  // At rest, an open list follows its teams (one added while open): keep
  // its recorded height true for a later drop.
  useLayoutEffect(() => {
    for (const id of state.expanded) {
      if (motions.current.has(id)) continue;
      const el = document.getElementById(stripTeamsId(id));
      if (el) heights.current.set(id, el.offsetHeight);
    }
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
      for (const handle of [...motions.current.values()]) handle.finish();
    };
    list.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      list.removeEventListener("wheel", takeOver);
      for (const handle of motions.current.values()) handle.stop();
    };
  }, [listRef]);

  return {
    /** Whether a workspace's list is open, and whether it is drawn (open,
     * or still folding away). */
    isExpanded: (wsId: string) => state.expanded.includes(wsId),
    isDrawn: (wsId: string) => state.expanded.includes(wsId) || state.leaving.includes(wsId),
    toggle: (wsId: string) => dispatch({ kind: "toggle", wsId }),
  };
}
