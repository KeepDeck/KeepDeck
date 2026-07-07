import { paneAtPoint, type PaneRect } from "../domain/deck";
import { formatDroppedPaths } from "../domain/terminal";
import { writeToPane } from "./paneInput";

/**
 * Snapshot the live viewport rects of the panes in the ACTIVE grid. Scoped to
 * the non-hidden grid (`.deck__grid:not(.deck__grid--hidden)`) so a drop can't
 * resolve to a pane in an inactive workspace stacked at the same coordinates.
 */
export function collectPaneRects(doc: Document = document): PaneRect[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(
      ".deck__grid:not(.deck__grid--hidden) [data-pane-id]",
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
 * Insert dropped paths into the target pane's PTY input. Returns false when
 * there is no target pane or nothing to insert.
 */
export function deliverDrop(
  paneId: string | null,
  paths: string[],
  isImage: boolean[],
): boolean {
  if (!paneId || paths.length === 0) return false;
  return writeToPane(paneId, formatDroppedPaths(paths, isImage));
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
  rects: PaneRect[],
  isImageOf: (paths: string[]) => Promise<boolean[]>,
): Promise<string | null> {
  if (!path) return null;
  const id = paneAtPoint(point.x, point.y, rects);
  if (!id) return null;
  const isImage = await isImageOf([path]).catch(() => [false]);
  return deliverDrop(id, [path], isImage) ? id : null;
}
