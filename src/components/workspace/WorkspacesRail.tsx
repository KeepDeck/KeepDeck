import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { noAutoCorrect } from "../../ui/inputProps";
import { collectRailItemRects } from "../../app/railDnd";
import {
  animateElementReorder,
  animateFixedElementToRect,
  snapshotElementRects,
  usePointerDrag,
  type ElementRectSnapshot,
} from "../../app/dragManager";
import { railItemAtY } from "../../domain/deck";

/** View model for the rail (the domain `Workspace` lives in `../workspaces`). */
export interface WorkspaceItem {
  id: string;
  name: string;
  agentCount: number;
}

interface WorkspacesRailProps {
  workspaces: WorkspaceItem[];
  activeId: string;
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
  onRename(id: string, name: string): void;
  /** Move workspace `id` to `toIndex` (long-press drag reorder). */
  onReorder(id: string, toIndex: number): void;
}

/** Hold this long before a press turns into a reorder drag (vs. a select click). */
const LONG_PRESS_MS = 300;
/** Moving more than this before the hold arms cancels it — it wasn't a hold. */
const MOVE_CANCEL_PX = 10;
const REORDER_ANIMATION_MS = 140;

interface DragSource {
  id: string;
  name: string;
  active: boolean;
  grabOffsetY: number;
  rect: { left: number; top: number; width: number; height: number };
}

/** Snapshot of the item being dragged, used to render the floating ghost. */
interface DragGhost {
  id: string;
  name: string;
  active: boolean;
  left: number;
  width: number;
  height: number;
  top: number;
}

/** Left rail listing workspaces with their agent counts. The active one is
 * highlighted and shows a × (also on hover); double-clicking a name renames it;
 * press-and-hold an item to drag it into a new position. */
export function WorkspacesRail({
  workspaces,
  activeId,
  onSelect,
  onAdd,
  onClose,
  onRename,
  onReorder,
}: WorkspacesRailProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [ghost, setGhost] = useState<DragGhost | null>(null);

  const listRef = useRef<HTMLUListElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const flipBefore = useRef<ElementRectSnapshot | null>(null);
  const cancelSettle = useRef<(() => void) | null>(null);

  // Position the ghost once when a drag begins (ghost identity is stable for the
  // whole drag); thereafter pointermove moves it directly via the ref, and since
  // `top` isn't in the JSX, list re-renders from reordering don't reset it.
  useLayoutEffect(() => {
    if (ghost && ghostRef.current) ghostRef.current.style.top = `${ghost.top}px`;
  }, [ghost]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !flipBefore.current) return;
    const before = flipBefore.current;
    flipBefore.current = null;
    animateElementReorder(railItemElements(list), railItemId, before, {
      durationMs: REORDER_ANIMATION_MS,
    });
  }, [workspaces]);

  useEffect(
    () => () => {
      cancelSettle.current?.();
      cancelSettle.current = null;
    },
    [],
  );

  const startEdit = (item: WorkspaceItem) => {
    setEditingId(item.id);
    setDraft(item.name);
  };
  const commitEdit = () => {
    if (editingId) {
      const name = draft.trim();
      if (name) onRename(editingId, name);
    }
    setEditingId(null);
  };

  const settleGhost = (id: string) => {
    const ghostEl = ghostRef.current;
    const slot = railItemElements(listRef.current).find((el) => railItemId(el) === id);
    if (!ghostEl || !slot) {
      setGhost(null);
      return;
    }
    const rect = railItemLayoutRect(listRef.current, slot);
    cancelSettle.current = animateFixedElementToRect(
      ghostEl,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      {
        durationMs: REORDER_ANIMATION_MS,
        opacity: 0.65,
        transform: "scale(1)",
        onDone: () => {
          cancelSettle.current = null;
          setGhost(null);
        },
      },
    );
  };

  const drag = usePointerDrag<DragSource>({
    holdMs: LONG_PRESS_MS,
    cancelBeforeStartPx: MOVE_CANCEL_PX,
    onStart: ({ source }) => {
      cancelSettle.current?.();
      cancelSettle.current = null;
      setGhost({
        id: source.id,
        name: source.name,
        active: source.active,
        left: source.rect.left,
        width: source.rect.width,
        height: source.rect.height,
        top: source.rect.top,
      });
    },
    onMove: ({ source, current }) => {
      if (ghostRef.current) {
        ghostRef.current.style.top = `${current.y - source.grabOffsetY}px`;
      }
      const list = listRef.current;
      if (!list) return;
      const rects = collectRailItemRects(list);
      const overId = railItemAtY(current.y, rects);
      if (!overId || overId === source.id) return;
      const toIndex = rects.findIndex((r) => r.id === overId);
      if (toIndex < 0) return;
      flipBefore.current = snapshotElementRects(railItemElements(list), railItemId);
      onReorder(source.id, toIndex);
    },
    onDrop: ({ source }) => settleGhost(source.id),
    onCancel: () => setGhost(null),
  });

  const onItemPointerDown = (
    e: React.PointerEvent<HTMLLIElement>,
    ws: WorkspaceItem,
  ) => {
    // Primary button only; never start a drag from the × or while renaming.
    if (e.button !== 0 || editingId) return;
    if ((e.target as HTMLElement).closest(".rail__close")) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.startPointerDrag(e.nativeEvent, {
      id: ws.id,
      name: ws.name,
      active: ws.id === activeId,
      grabOffsetY: e.clientY - r.top,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    });
  };

  return (
    <nav className="rail" aria-label="Workspaces">
      <div className="rail__head">
        <span className="rail__title">Workspaces</span>
        <button
          type="button"
          className="rail__add"
          onClick={onAdd}
          title="Add workspace"
          aria-label="Add workspace"
        >
          +
        </button>
      </div>
      <ul
        ref={listRef}
        className={`rail__list${ghost ? " rail__list--reordering" : ""}`}
      >
        {workspaces.map((ws) => {
          const active = ws.id === activeId;
          if (ws.id === editingId) {
            return (
              <li key={ws.id} className="rail__item">
                <input
                  {...noAutoCorrect}
                  className="rail__rename"
                  value={draft}
                  autoFocus
                  aria-label="Workspace name"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    else if (e.key === "Escape") setEditingId(null);
                  }}
                />
              </li>
            );
          }
          return (
            <li
              key={ws.id}
              data-ws-id={ws.id}
              className={`rail__item${active ? " rail__item--active" : ""}${
                ws.id === ghost?.id ? " rail__item--placeholder" : ""
              }`}
              onPointerDown={(e) => onItemPointerDown(e, ws)}
            >
              <button
                type="button"
                className="rail__select"
                onClick={() => onSelect(ws.id)}
                onDoubleClick={() => startEdit(ws)}
                aria-current={active}
              >
                <span className="rail__dot" />
                <span className="rail__name">{ws.name}</span>
              </button>
              <span className="rail__count">{ws.agentCount}</span>
              <button
                type="button"
                className="rail__close"
                onClick={() => onClose(ws.id)}
                title="Close workspace"
                aria-label={`Close ${ws.name}`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      {ghost &&
        createPortal(
          <div
            ref={ghostRef}
            className={`rail__ghost${ghost.active ? " rail__ghost--active" : ""}`}
            style={{ left: ghost.left, width: ghost.width, height: ghost.height }}
          >
            <span className="rail__dot" />
            <span className="rail__name">{ghost.name}</span>
          </div>,
          document.body,
        )}
    </nav>
  );
}

function railItemElements(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>("[data-ws-id]")];
}

function railItemId(element: HTMLElement): string {
  return element.dataset.wsId ?? "";
}

function railItemLayoutRect(list: HTMLElement | null, item: HTMLElement) {
  const listRect = list?.getBoundingClientRect();
  return {
    left: (listRect?.left ?? 0) + item.offsetLeft - (list?.scrollLeft ?? 0),
    top: (listRect?.top ?? 0) + item.offsetTop - (list?.scrollTop ?? 0),
    width: item.offsetWidth,
    height: item.offsetHeight,
  };
}
