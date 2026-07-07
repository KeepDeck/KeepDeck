import { useEffect, useRef } from "react";
import { pathsAreImages } from "../ipc/app";
import { collectPaneRects, deliverPathToPoint } from "./dragDrop";

/**
 * Deliver an in-app POINTER drag of a file path onto the pane under the cursor.
 * A drag source (the Files plugin's tree) tags each row with the file path in a
 * `data-kd-drag-path` attribute; pressing and dragging a row shows a small
 * floating label, and releasing over a pane writes the path into that pane's
 * PTY — the same delivery the OS file drop uses (`useDragDrop`).
 *
 * Pointer events, NOT HTML5 drag-and-drop: Tauri's native OS drag-drop handler
 * (required for Finder file drops) disables HTML5 DnD inside the webview, so a
 * `dragstart`/`drop` approach never fires. Pointer events are not intercepted.
 * Listeners are document-level and CAPTURE-phase so the terminal can't consume
 * the stream, and hit-testing is by coordinate (`paneAtPoint`) so it works over
 * the xterm canvas without the panes knowing about it. `onDropped` fires with
 * the pane id so the caller can focus it.
 */
const DRAG_PATH_ATTR = "data-kd-drag-path";
const DRAG_THRESHOLD_PX = 5;

export function usePaneDrag(onDropped: (paneId: string) => void) {
  const droppedRef = useRef(onDropped);
  droppedRef.current = onDropped;

  useEffect(() => {
    let path: string | null = null; // the pressed row's path, if any
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let ghost: HTMLElement | null = null;

    const reset = () => {
      path = null;
      dragging = false;
      ghost?.remove();
      ghost = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const source = (event.target as Element | null)?.closest(
        `[${DRAG_PATH_ATTR}]`,
      );
      const pressed = source?.getAttribute(DRAG_PATH_ATTR);
      if (!pressed) return;
      path = pressed;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!path) return;
      if (!dragging) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX)
          return;
        dragging = true;
        ghost = makeGhost(path);
        document.body.appendChild(ghost);
      }
      // Keep the terminal out of our drag's pointer stream.
      event.preventDefault();
      event.stopPropagation();
      moveGhost(ghost!, event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) {
        reset();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const droppedPath = path!;
      const point = { x: event.clientX, y: event.clientY };
      reset();
      // A drag that starts and ends on the same row would otherwise fire a
      // click and open the file; swallow that one immediate click.
      suppressNextClick();
      void deliverPathToPoint(
        droppedPath,
        point,
        collectPaneRects(),
        pathsAreImages,
      ).then((id) => {
        if (id) droppedRef.current(id);
      });
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", reset, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", reset, true);
      reset();
    };
  }, []);
}

/** Swallow the single click that a same-element drag leaves behind — but only
 * an immediate one, so a later real click is never eaten. */
function suppressNextClick(): void {
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    cleanup();
  };
  const cleanup = () => document.removeEventListener("click", onClick, true);
  document.addEventListener("click", onClick, true);
  setTimeout(cleanup, 0);
}

function makeGhost(path: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pane-drag-ghost";
  el.textContent = baseName(path);
  return el;
}

function moveGhost(el: HTMLElement, x: number, y: number): void {
  el.style.transform = `translate(${x + 12}px, ${y + 14}px)`;
}

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? path : path.slice(index + 1);
}
