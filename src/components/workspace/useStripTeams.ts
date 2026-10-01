import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import {
  NOTHING_LISTED,
  expandTeams,
  listChanges,
  planListMotions,
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
 * shutting folds them away with the strip. A drag holds the strip as it
 * is — except the dragged workspace's own list, which folds out of the way
 * and reopens where it lands.
 *
 * Every list motion runs height and scroll on one curve
 * (`animateTeamList`), to the numbers `stripExpand` computes — the row a
 * list hangs from never moves on its own, and only one motion at a time
 * drives the scroll.
 */
export function useStripTeams(
  open: boolean,
  /** The workspace a drag holds, or null: its own list folds out of the
   * way, and reopens where it lands. */
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
        ? {
            kind: "open",
            activeId: active?.id ?? "",
            listable: view.marks.filter((mark) => mark.teams.length > 0).map((mark) => mark.id),
          }
        : { kind: "close" },
    );
    // Only the strip opening or shutting re-decides: the active mark's
    // teams changing under an open strip must not yank a list the person
    // moved elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Before paint, like open and close: the drag's first frame already
  // carries just the mark.
  useLayoutEffect(() => {
    dispatch(dragged !== null ? { kind: "hold", wsId: dragged } : { kind: "release" });
  }, [dragged]);

  const before = useRef(NOTHING_LISTED);
  /** One running motion per list: lists open and fold independently. */
  const motions = useRef(new Map<string, MotionHandle>());

  /** The ONE motion writing the scroll, across every commit: a new
   * scroll-driving motion takes the scroll from it rather than fight it. */
  const scrollOwner = useRef<MotionHandle | null>(null);
  const stopMotion = (id: string) => {
    motions.current.get(id)?.stop();
    motions.current.delete(id);
  };
  const start = (id: string, handle: MotionHandle, drivesScroll: boolean) => {
    motions.current.set(id, handle);
    if (!drivesScroll) return;
    scrollOwner.current?.releaseScroll();
    scrollOwner.current = handle;
  };

  // Measure, plan, run: the plan (which lists move, which ONE carries the
  // scroll) is stripExpand's; this reads the DOM it needs and starts the
  // motions it decided.
  useLayoutEffect(() => {
    const list = listRef.current;
    const was = before.current;
    before.current = state;
    if (!list) return;
    const block = (id: string) => document.getElementById(stripTeamsId(id));
    const { opened, folding } = listChanges(was, state);
    if (opened.length === 0 && folding.length === 0) return;
    const listBox = list.getBoundingClientRect();
    const elements = new Map<string, HTMLElement>();

    // Two passes for the openers: every one measured at where it starts
    // before any row is read, so all rows come from ONE layout.
    const starts = opened.flatMap((id) => {
      const el = block(id);
      if (!el) return [];
      elements.set(id, el);
      // A list caught mid-fold opens from the height it reached, not from
      // nothing — reopening under the pointer must not snap it shut first.
      const reached = el.style.height === "" ? 0 : parseFloat(el.style.height) || 0;
      el.style.height = "auto";
      const full = el.scrollHeight;
      el.style.height = `${reached}px`;
      return [{ id, reached, full }];
    });
    const opening = starts.map((start) => {
      const head = elements.get(start.id)!.previousElementSibling ?? elements.get(start.id)!;
      const row = head.getBoundingClientRect();
      return { ...start, row: { top: row.top - listBox.top, bottom: row.bottom - listBox.top } };
    });
    const folds = folding.flatMap((id) => {
      const el = block(id);
      if (!el) {
        dispatch({ kind: "settled", wsId: id });
        return [];
      }
      elements.set(id, el);
      return [{ id, height: el.offsetHeight }];
    });

    const plans = planListMotions(
      opening,
      folds,
      active?.id ?? null,
      view.marks.map((mark) => mark.id),
      { scrollTop: list.scrollTop, viewportHeight: list.clientHeight, contentHeight: list.scrollHeight },
    );
    const durationMs = prefersReducedMotion() ? 0 : STRIP_MOTION_MS;
    for (const plan of plans) {
      const el = elements.get(plan.id)!;
      const opens = plan.to > 0;
      stopMotion(plan.id);
      start(
        plan.id,
        animateTeamList({ block: el, list, ...plan, durationMs }, browserClock, () => {
          motions.current.delete(plan.id);
          if (opens) {
            // Settled: back to its natural height, so a team added or gone
            // while it is open simply grows or shrinks it.
            el.style.height = "";
          } else {
            dispatch({ kind: "settled", wsId: plan.id });
          }
        }),
        plan.scrollTo !== null,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.expanded, state.leaving]);

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
