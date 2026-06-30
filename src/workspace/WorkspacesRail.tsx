import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { noAutoCorrect } from "../ui/inputProps";
import { collectRailItemRects, railItemAtY } from "./railDnd";

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
const LONG_PRESS_MS = 350;
/** Moving more than this before the hold arms cancels it — it wasn't a hold. */
const MOVE_CANCEL_PX = 10;

interface PressSession {
  id: string;
  pointerId: number;
  startY: number;
  timer: number;
  dragging: boolean;
  /** Cursor offset from the item's top edge, so the ghost tracks where grabbed. */
  grabOffsetY: number;
  /** The item's on-screen box at press time (the ghost copies it). */
  rect: { left: number; top: number; width: number; height: number };
  /** Window listeners for this press, kept so they can be removed on release. */
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
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
  const press = useRef<PressSession | null>(null);
  // A drop fires a synthesized click on release; swallow that one so the drag
  // doesn't also select. Reset whenever a fresh press starts or a click is used.
  const justDragged = useRef(false);

  // Position the ghost once when a drag begins (ghost identity is stable for the
  // whole drag); thereafter pointermove moves it directly via the ref, and since
  // `top` isn't in the JSX, list re-renders from reordering don't reset it.
  useLayoutEffect(() => {
    if (ghost && ghostRef.current) ghostRef.current.style.top = `${ghost.top}px`;
  }, [ghost]);

  /** Tear down the active press: stop the hold timer and detach its listeners. */
  const endPress = () => {
    const s = press.current;
    if (!s) return;
    clearTimeout(s.timer);
    window.removeEventListener("pointermove", s.onMove);
    window.removeEventListener("pointerup", s.onUp);
    window.removeEventListener("pointercancel", s.onUp);
    press.current = null;
  };

  // Safety net: never leave window listeners (or a ghost) behind on unmount.
  useEffect(() => endPress, []);

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

  const onItemPointerDown = (
    e: React.PointerEvent<HTMLLIElement>,
    ws: WorkspaceItem,
  ) => {
    // Primary button only; never start a drag from the × or while renaming.
    if (e.button !== 0 || editingId) return;
    if ((e.target as HTMLElement).closest(".rail__close")) return;
    justDragged.current = false;
    endPress(); // belt-and-braces: clear any stale prior session
    const r = e.currentTarget.getBoundingClientRect();
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };

    // Move/up are bound to the window (not the item) so a live DOM reorder can't
    // strip the listeners mid-drag — that was leaving the ghost stuck on release.
    const onMove = (ev: PointerEvent) => {
      const s = press.current;
      if (!s || s.pointerId !== ev.pointerId) return;
      if (!s.dragging) {
        // Drifted before the hold armed → it's a click, not a drag.
        if (Math.abs(ev.clientY - s.startY) > MOVE_CANCEL_PX) endPress();
        return;
      }
      ev.preventDefault();
      if (ghostRef.current) {
        ghostRef.current.style.top = `${ev.clientY - s.grabOffsetY}px`;
      }
      const list = listRef.current;
      if (!list) return;
      const overId = railItemAtY(ev.clientY, collectRailItemRects(list));
      if (overId && overId !== s.id) {
        const toIndex = workspaces.findIndex((w) => w.id === overId);
        if (toIndex >= 0) onReorder(s.id, toIndex);
      }
    };
    const onUp = (ev: PointerEvent) => {
      const s = press.current;
      if (!s || s.pointerId !== ev.pointerId) return;
      if (s.dragging) {
        justDragged.current = true; // swallow the post-drop click
        setGhost(null);
      }
      endPress();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    const timer = window.setTimeout(() => {
      const s = press.current;
      if (s?.id !== ws.id) return;
      s.dragging = true;
      setGhost({
        id: ws.id,
        name: ws.name,
        active: ws.id === activeId,
        left: s.rect.left,
        width: s.rect.width,
        height: s.rect.height,
        top: s.rect.top,
      });
    }, LONG_PRESS_MS);

    press.current = {
      id: ws.id,
      pointerId: e.pointerId,
      startY: e.clientY,
      timer,
      dragging: false,
      grabOffsetY: e.clientY - r.top,
      rect,
      onMove,
      onUp,
    };
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
                onClick={() => {
                  if (justDragged.current) {
                    justDragged.current = false;
                    return;
                  }
                  onSelect(ws.id);
                }}
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
