import {
  paneAtPoint,
  type DropSurface,
  type PaneRect,
  type Rect,
} from "../domain/deck";
import { formatDroppedPaths } from "../domain/terminal";
import { writeRawToPane } from "./paneInput";

/**
 * Snapshot the live viewport rects of the panes in the ACTIVE workspace.
 * Scoped to the non-hidden workspace layer (`.deck__workspace`) so a drop
 * can't resolve to a pane in an inactive workspace stacked at the same
 * coordinates (inactive layers are visibility:hidden — their rects are real).
 * Covers both layouts (the layer holds a grid or a list). Panes that are
 * display:none (minimized, or hidden behind a maximize) yield zero-size rects
 * no drop point can hit.
 */
export function collectPaneRects(doc: Document = document): PaneRect[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(
      ".deck__workspace:not(.deck__workspace--hidden) [data-pane-id]",
    ),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.dataset.paneId ?? "",
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  });
}

/**
 * Snapshot everything at the drop point, panes and the chrome over them, in one
 * pass over the live layout — the two halves must describe the SAME moment, or
 * a point could clear a blocker that has since moved across it.
 *
 * The only blocker today is a floating dock (`.dock--floating`): docked, it is
 * a flex sibling that never overlaps a pane and the selector finds nothing.
 * Modal surfaces are deliberately absent — they take the pointer outright, and
 * an OS drop landing under one behaves as it always has.
 */
export function collectDropSurface(doc: Document = document): DropSurface {
  const blockers = Array.from(
    doc.querySelectorAll<HTMLElement>(".dock--floating"),
  ).map((el): Rect => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  return { panes: collectPaneRects(doc), blockers };
}

/**
 * Insert dropped paths into the target pane's PTY input. Returns false when
 * there is no target pane or nothing to insert.
 */
export function deliverDrop(
  paneId: string | null,
  paths: string[],
  isImage: boolean[],
): boolean {
  if (!paneId || paths.length === 0) return false;
  return writeRawToPane(paneId, formatDroppedPaths(paths, isImage));
}

/**
 * Deliver a dragged file `path` released at `point`: hit-test the pane under the
 * point against `rects`, decide image-vs-text, and write the path into that
 * pane's PTY. Returns the target pane id on delivery, else null. The SAME core
 * as the OS file drop (`paneAtPoint` + `deliverDrop`), reached from the plugin
 * tree's POINTER drag (see `usePaneDrag`) — a Finder drop and a dragged tree
 * row land in the terminal identically. Pointer-based, not HTML5 drag-and-drop:
 * Tauri's native OS drag-drop (needed for Finder file drops) disables HTML5 DnD
 * inside the webview. `isImageOf` is injected (the `paths_are_images` IPC in the
 * app, a fake in tests).
 */
export async function deliverPathToPoint(
  path: string,
  point: { x: number; y: number },
  surface: DropSurface,
  isImageOf: (paths: string[]) => Promise<boolean[]>,
): Promise<string | null> {
  if (!path) return null;
  const id = paneAtPoint(point.x, point.y, surface);
  if (!id) return null;
  const isImage = await isImageOf([path]).catch(() => [false]);
  return deliverDrop(id, [path], isImage) ? id : null;
}
