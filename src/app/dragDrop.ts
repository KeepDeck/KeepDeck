import {
  paneAtPoint,
  type DropSurface,
  type PaneRect,
  type Rect,
} from "../domain/deck";
import { DROP_BLOCKER_ATTR } from "@keepdeck/ui-kit/dropBlocker";
import { formatDroppedPaths } from "../domain/terminal";
import { describeError, log } from "../ipc/log";
import { writeRawToPane } from "./paneInput";

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
 * Who blocks is declared by the surfaces themselves (`DROP_BLOCKER_ATTR`, in
 * ui-kit so every surface that needs it can reach it), not enumerated here, so
 * a new one arrives with the code that renders it rather than by someone
 * remembering this function exists. A surface that is present but not laid out
 * (a hidden overlay) reports a zero rect, which contains no point — so absence
 * needs no special case.
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
 *
 * Module-private, like the pane snapshot and for the same reason: it is the
 * write step alone, reachable without the blocker hit-test, the empty-path
 * filter or the image sniff. Exported, it would be the shortest way to type a
 * path into a pane — and the shortest way is the one the next surface takes.
 */
function deliverDrop(
  paneId: string | null,
  paths: string[],
  isImage: boolean[],
): boolean {
  if (!paneId || paths.length === 0) return false;
  return writeRawToPane(paneId, formatDroppedPaths(paths, isImage));
}

/**
 * Deliver `paths` released at `point`: hit-test the pane under the point
 * against `surface`, decide image-vs-text, and write them into that pane's
 * PTY. Returns the target pane id on delivery, else null.
 *
 * The WHOLE sequence, for both ways a file can be dropped — an OS drop from
 * Finder ([`useDragDrop`]) and a pointer drag of a plugin tree row
 * ([`usePaneDrag`]). Each used to assemble these steps for itself, which is
 * how they came to disagree about a failed image sniff: one traced it, the
 * other swallowed it, so the same backend failure was diagnosable through one
 * entry point and invisible through the other. Only the surface snapshot stays
 * with the callers — it is a live DOM read, and injecting it is what keeps
 * this testable.
 *
 * Pointer-based, not HTML5 drag-and-drop: Tauri's native OS drag-drop (needed
 * for Finder file drops) disables HTML5 DnD inside the webview. `isImageOf` is
 * injected (the `paths_are_images` IPC in the app, a fake in tests).
 */
export async function deliverPathsToPoint(
  paths: string[],
  point: { x: number; y: number },
  surface: DropSurface,
  isImageOf: (paths: string[]) => Promise<boolean[]>,
): Promise<string | null> {
  const dropped = paths.filter((path) => path !== "");
  if (dropped.length === 0) return null;
  const id = paneAtPoint(point.x, point.y, surface);
  if (!id) return null;
  // A sniff that fails is not a drop that fails — the paths still go in, as
  // text. Traced, because a silently degraded drop looks like a working one.
  const isImage = await isImageOf(dropped).catch((e: unknown) => {
    log.debug("web:dnd", `image sniff failed, treating drop as text: ${describeError(e)}`);
    return dropped.map(() => false);
  });
  return deliverDrop(id, dropped, isImage) ? id : null;
}
