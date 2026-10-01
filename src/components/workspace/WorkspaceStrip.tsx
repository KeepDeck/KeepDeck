import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronIcon, PlusIcon } from "@keepdeck/ui-kit/icons";
import { collectMarkRects } from "../../app/stripDnd";
import {
  animateElementReorder,
  animateFixedElementToRect,
  snapshotElementRects,
  usePointerDrag,
  type ElementRectSnapshot,
} from "../../app/dragManager";
import { markAtY } from "../../domain/deck";
import { STRIP_WORDS, type StripView, type WorkspaceMark } from "../../presentation/stripView";
import { teamsToggleView } from "../../presentation/stripExpand";
import { useStripReveal } from "./useStripReveal";
import { stripTeamsId, useStripTeams } from "./useStripTeams";

interface WorkspaceStripProps {
  view: StripView;
  onSelect(id: string): void;
  /** Open team `teamId` of workspace `wsId` — a team row of the slid-open
   * strip. */
  onEnterTeam(wsId: string, teamId: string): void;
  onAdd(): void;
  /** Move workspace `id` to `toIndex` (long-press drag reorder). */
  onReorder(id: string, toIndex: number): void;
  /** The running build, or null until `app_info` answers. At the strip's
   * foot: read a few times a year, when a report needs writing — on screen,
   * and out of the way. */
  version: string | null;
}

/** Hold this long before a press turns into a reorder drag (vs. a select click). */
const LONG_PRESS_MS = 300;
/** Moving more than this before the hold arms cancels it — it wasn't a hold. */
const MOVE_CANCEL_PX = 10;
const REORDER_ANIMATION_MS = 140;

interface DragSource {
  mark: WorkspaceMark;
  grabOffsetY: number;
  rect: { left: number; top: number; width: number; height: number };
}

/** Snapshot of the mark being dragged, used to render the floating ghost. */
interface DragGhost {
  mark: WorkspaceMark;
  left: number;
  width: number;
  height: number;
  top: number;
}

/**
 * The left strip: a column of workspace marks — «+» pinned on top, the
 * marks under it (press-and-hold one to drag it to a new place), the build
 * at the foot. Resting the pointer on it opens it over the stage — the
 * stage does not move (`useStripReveal`) — as the team switcher: each
 * workspace's full name beside its mark, and one workspace's teams under
 * it (`useStripTeams`). A mark goes to its workspace (the team it last had
 * open, or its cards screen); a chevron moves the one list; a team row
 * goes to that team. The cards screen stays the keyboard's way to a team.
 */
export function WorkspaceStrip({
  view,
  onSelect,
  onEnterTeam,
  onAdd,
  onReorder,
  version,
}: WorkspaceStripProps) {
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const reveal = useStripReveal(ghost !== null);

  const listRef = useRef<HTMLDivElement>(null);
  const teams = useStripTeams(reveal.open, ghost?.mark.id ?? null, view, listRef);
  /** How far the held mark moved when the drag dropped the open team list
   * and the scroll could not give it all back — the hand is that much below
   * its mark, so the drag reads the hand as if it were not. Measured on the
   * first move, once the drop has landed. */
  const dragShift = useRef<number | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const flipBefore = useRef<ElementRectSnapshot | null>(null);
  const cancelSettle = useRef<(() => void) | null>(null);

  // Position the ghost once when a drag begins; thereafter pointermove moves
  // it directly via the ref, so list re-renders from reordering never reset it.
  useLayoutEffect(() => {
    if (ghost && ghostRef.current) ghostRef.current.style.top = `${ghost.top}px`;
  }, [ghost]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !flipBefore.current) return;
    const before = flipBefore.current;
    flipBefore.current = null;
    animateElementReorder(markElements(list), markId, before, {
      durationMs: REORDER_ANIMATION_MS,
    });
  }, [view.marks]);

  useEffect(
    () => () => {
      cancelSettle.current?.();
      cancelSettle.current = null;
    },
    [],
  );

  const settleGhost = (id: string) => {
    const ghostEl = ghostRef.current;
    const slot = markElements(listRef.current).find((el) => markId(el) === id);
    if (!ghostEl || !slot) {
      setGhost(null);
      return;
    }
    const rect = markLayoutRect(listRef.current, slot);
    cancelSettle.current = animateFixedElementToRect(ghostEl, rect, {
      durationMs: REORDER_ANIMATION_MS,
      opacity: 0.65,
      transform: "scale(1)",
      onDone: () => {
        cancelSettle.current = null;
        setGhost(null);
      },
    });
  };

  const drag = usePointerDrag<DragSource>({
    holdMs: LONG_PRESS_MS,
    cancelBeforeStartPx: MOVE_CANCEL_PX,
    onStart: ({ source }) => {
      cancelSettle.current?.();
      cancelSettle.current = null;
      dragShift.current = null;
      setGhost({ mark: source.mark, ...source.rect });
    },
    onMove: ({ source, current }) => {
      const list = listRef.current;
      if (dragShift.current === null) {
        const slot = markElements(list).find((el) => markId(el) === source.mark.id);
        dragShift.current = slot ? source.rect.top - markLayoutRect(list, slot).top : 0;
      }
      // Where the hand is, as the column now stands under it.
      const y = current.y - dragShift.current;
      if (ghostRef.current) {
        ghostRef.current.style.top = `${y - source.grabOffsetY}px`;
      }
      if (!list) return;
      const rects = collectMarkRects(list);
      const overId = markAtY(y, rects);
      if (!overId || overId === source.mark.id) return;
      const toIndex = rects.findIndex((r) => r.id === overId);
      if (toIndex < 0) return;
      flipBefore.current = snapshotElementRects(markElements(list), markId);
      onReorder(source.mark.id, toIndex);
    },
    onDrop: ({ source }) => settleGhost(source.mark.id),
    onCancel: () => setGhost(null),
  });

  const onMarkPointerDown = (e: React.PointerEvent<HTMLButtonElement>, mark: WorkspaceMark) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.startPointerDrag(e.nativeEvent, {
      mark,
      grabOffsetY: e.clientY - r.top,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    });
  };

  return (
    <nav
      className={`strip${reveal.open ? " strip--revealed" : ""}`}
      aria-label={STRIP_WORDS.nav}
    >
      <div className="strip__col" {...reveal.handlers}>
        <button
          type="button"
          className="strip__mark strip__mark--add"
          onClick={onAdd}
          aria-label={STRIP_WORDS.addWorkspace}
          title={STRIP_WORDS.addWorkspace}
        >
          <span className="strip__tile" aria-hidden>
            <PlusIcon />
          </span>
          <span className="strip__name" aria-hidden>
            {STRIP_WORDS.addWorkspace}
          </span>
        </button>
        <div
          ref={listRef}
          className={`strip__marks${ghost ? " strip__marks--reordering" : ""}`}
        >
          {view.marks.map((mark) => {
            const expanded = teams.expanded === mark.id;
            const toggle = teamsToggleView(mark, expanded);
            const listId = stripTeamsId(mark.id);
            // Drawn while listed and while folding away.
            const drawn = expanded || teams.leaving === mark.id;
            return (
              // The GROUP is the reorder's item (data-ws-id), unpositioned
              // so the list stays the offsetParent the hit-test measures
              // through — and a reorder carries the teams with their mark.
              <div
                key={mark.id}
                data-ws-id={mark.id}
                className={`strip__group${
                  mark.id === ghost?.mark.id ? " strip__group--placeholder" : ""
                }`}
              >
                <div className="strip__head">
                  <button
                    type="button"
                    className={`strip__mark${mark.active ? " strip__mark--active" : ""}`}
                    onClick={() => {
                      onSelect(mark.id);
                      reveal.dismiss();
                    }}
                    onPointerDown={(e) => onMarkPointerDown(e, mark)}
                    aria-current={mark.active}
                    aria-label={mark.label}
                    title={mark.label}
                  >
                    <MarkFace mark={mark} />
                    <span className="strip__name" aria-hidden>
                      {mark.name}
                    </span>
                  </button>
                  {toggle && (
                    <button
                      type="button"
                      className="strip__toggle"
                      onClick={() => teams.toggle(mark.id)}
                      aria-label={toggle.label}
                      title={toggle.label}
                      aria-expanded={expanded}
                      aria-controls={expanded ? listId : undefined}
                      // Past the shut edge it is out of sight: out of reach
                      // too, until the strip opens.
                      tabIndex={reveal.open ? 0 : -1}
                      aria-hidden={!reveal.open}
                    >
                      {toggle.count !== null && (
                        <span className="strip__count">{toggle.count}</span>
                      )}
                      <ChevronIcon />
                    </button>
                  )}
                </div>
                {drawn && (
                  // Rendered only while listed: a shut strip holds no
                  // hidden rows to tab into.
                  <ul id={listId} className="strip__teams">
                    {mark.teams.map((team) => (
                      <li key={team.id}>
                        <button
                          type="button"
                          className={`strip__team${team.open ? " strip__team--open" : ""}`}
                          onClick={() => {
                            onEnterTeam(mark.id, team.id);
                            reveal.dismiss();
                          }}
                          aria-current={team.open}
                          aria-label={team.label}
                          title={team.label}
                        >
                          <span className={`team-dot team-dot--${team.dot}`} aria-hidden />
                          <span className="strip__team-name">{team.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {version !== null && (
          <footer className="strip__foot" title={STRIP_WORDS.build(version)}>
            {version}
          </footer>
        )}
      </div>

      {ghost &&
        createPortal(
          <div
            ref={ghostRef}
            className="strip__ghost"
            style={{ left: ghost.left, width: ghost.width, height: ghost.height }}
          >
            <MarkFace mark={ghost.mark} />
          </div>,
          document.body,
        )}
    </nav>
  );
}

/** A mark's face — the tile with its letters and dot. No name under it: at
 * the strip's width a name only fits as an ellipsis; the full one shows
 * beside the mark while the strip is open, and in the bar's first crumb.
 * The mark and its drag ghost share it: the ghost is the mark's image. */
function MarkFace({ mark }: { mark: WorkspaceMark }) {
  return (
    <>
      <span className="strip__tile" aria-hidden>
        {mark.initials}
        {mark.dot && <span className={`strip__dot strip__dot--${mark.dot}`} />}
      </span>
    </>
  );
}

function markElements(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>("[data-ws-id]")];
}

function markId(element: HTMLElement): string {
  return element.dataset.wsId ?? "";
}

/** Where the dropped ghost settles: the mark's layout box, measured through
 * the list (its only positioned ancestor), untouched by FLIP transforms. */
function markLayoutRect(list: HTMLElement | null, mark: HTMLElement) {
  const listRect = list?.getBoundingClientRect();
  return {
    left: (listRect?.left ?? 0) + mark.offsetLeft - (list?.scrollLeft ?? 0),
    top: (listRect?.top ?? 0) + mark.offsetTop - (list?.scrollTop ?? 0),
    width: mark.offsetWidth,
    height: mark.offsetHeight,
  };
}
