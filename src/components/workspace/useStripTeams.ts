import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import {
  NOTHING_LISTED,
  expandTeams,
  revealScrollTarget,
  scrollAfterCollapse,
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
 * shutting folds them away with the strip. A drag changes nothing here:
 * the strip holds open through it, lists and all.
 *
 * Every list motion runs height and scroll on one curve
 * (`animateTeamList`), to the numbers `stripExpand` computes — the row a
 * list hangs from never moves on its own, and only one motion at a time
 * drives the scroll.
 */
export function useStripTeams(
  open: boolean,
  /** A drag is in flight: the column belongs to it, so the resting
   * scroll-into-view holds off. */
  dragging: boolean,
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
        : { kind: "close" },
    );
    // Only the strip opening or shutting re-decides: the active mark's
    // teams changing under an open strip must not yank a list the person
    // moved elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const before = useRef(NOTHING_LISTED);
  /** One running motion per list: lists open and fold independently. */
  const motions = useRef(new Map<string, MotionHandle>());

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
            block: el,
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
            block: el,
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

  // At rest the column shows the workspace on screen: when the active one
  // changes (a hotkey, a notification, the crumb) and its mark is scrolled
  // out of the column, bring it in. Not while open — the person is reading
  // it — and not under a drag, which owns the column then.
  const activeId = active?.id ?? null;
  useLayoutEffect(() => {
    const list = listRef.current;
    // A column with no height yet (not laid out) has no view to keep.
    if (!list || open || dragging || activeId === null || list.clientHeight === 0) return;
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
