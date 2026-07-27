import {
  paneAtPoint,
  type DropSurface,
  type PaneRect,
  type Rect,
} from "../domain/deck";
import { formatDroppedPaths } from "../domain/terminal";
import { writeRawToPane } from "./paneInput";

/**
 * The marker a surface carries to say "a drop released on me is mine, not the
 * pane's". An ATTRIBUTE rather than a class name, and exported rather than
 * spelled twice: a class is presentation, and a rename would leave the writer
 * and this reader agreeing with their own tests and with nothing else — the
 * dock would keep looking floating and quietly stop blocking drops.
 *
 * Carry it on anything opaque that covers the deck while it is interactive.
 * Modal surfaces do not need it: they take the pointer outright.
 */
export const DROP_BLOCKER_ATTR = "data-kd-drop-blocker";

/** Narrow a live element's box to the plain rect the hit-test works in. */
function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/**
 * Snapshot the live viewport rects of the panes in the ACTIVE workspace.
 * Module-private on purpose: panes alone are half an answer, and an export
 * would let a future drop path hand them to `paneAtPoint` with no blockers —
 * spelling, in one plausible line, exactly the bug the blockers exist to stop.
 * Scoped to the non-hidden workspace layer (`.deck__workspace`) so a drop
 * can't resolve to a pane in an inactive workspace stacked at the same
 * coordinates (inactive layers are visibility:hidden — their rects are real).
 * Covers both layouts (the layer holds a grid or a list). Panes that are
 * display:none (minimized, or hidden behind a maximize) yield zero-size rects
 * no drop point can hit.
 */
function collectPaneRects(doc: Document = document): PaneRect[] {
  return Array.from(
    doc.querySelectorAll<HTMLElement>(
      ".deck__workspace:not(.deck__workspace--hidden) [data-pane-id]",
    ),
  ).map((el) => ({ id: el.dataset.paneId ?? "", rect: rectOf(el) }));
}

/**
 * Snapshot everything a drop point can land on — the panes, and the surfaces
 * covering them. Both halves are read synchronously here, so they describe the
 * same layout: a point must not clear a blocker that has since moved across it.
 *
 * Who blocks is declared by the surfaces themselves ([`DROP_BLOCKER_ATTR`]),
 * not enumerated here, so a new one arrives with the code that renders it
 * rather than by someone remembering this function exists. A surface that is
 * present but not laid out (a hidden overlay) reports a zero rect, which
 * contains no point — so absence needs no special case.
 */
export function collectDropSurface(doc: Document = document): DropSurface {
  const blockers = Array.from(
    doc.querySelectorAll(`[${DROP_BLOCKER_ATTR}]`),
  ).map(rectOf);
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
 * point against `surface`, decide image-vs-text, and write the path into that
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
