import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PlusIcon } from "@keepdeck/ui-kit/icons";
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
import { useStripReveal } from "./useStripReveal";

interface WorkspaceStripProps {
  view: StripView;
  onSelect(id: string): void;
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
 * at the foot. Teams are reached on the stage's cards screen. Resting the
 * pointer on it opens it over the stage with each workspace's full name
 * beside its mark (`useStripReveal`) — the stage does not move.
 */
export function WorkspaceStrip({ view, onSelect, onAdd, onReorder, version }: WorkspaceStripProps) {
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const reveal = useStripReveal(ghost !== null);

  const listRef = useRef<HTMLDivElement>(null);
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
      setGhost({ mark: source.mark, ...source.rect });
    },
    onMove: ({ source, current }) => {
      if (ghostRef.current) {
        ghostRef.current.style.top = `${current.y - source.grabOffsetY}px`;
      }
      const list = listRef.current;
      if (!list) return;
      const rects = collectMarkRects(list);
      const overId = markAtY(current.y, rects);
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
          {view.marks.map((mark) => (
            <button
              key={mark.id}
              type="button"
              data-ws-id={mark.id}
              className={`strip__mark${mark.active ? " strip__mark--active" : ""}${
                mark.id === ghost?.mark.id ? " strip__mark--placeholder" : ""
              }`}
              onClick={() => onSelect(mark.id)}
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
          ))}
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
