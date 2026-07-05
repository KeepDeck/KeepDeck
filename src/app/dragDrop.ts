import { type PaneRect } from "../domain/dnd";
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
