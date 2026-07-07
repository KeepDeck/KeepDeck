import { paneAtPoint, type PaneRect } from "../domain/deck";
import { formatDroppedPaths } from "../domain/terminal";
import { writeToPane } from "./paneInput";

/**
 * The dataTransfer MIME an in-app dragged file path travels under, from a drag
 * source (the Files plugin's tree) to the host's pane-drop handler. A DEDICATED
 * type — not text/plain — so only an intentional file drag delivers into a PTY,
 * and a dragged text selection never does. Mirrored by the Files plugin
 * (plugins/files/src/dnd.ts); the two strings MUST stay in lockstep.
 */
export const PANE_PATH_DROP_TYPE = "application/x-keepdeck-path";

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
 * Deliver an in-app HTML5 path drop: if the transfer carries our type, hit-test
 * the drop point against `rects`, decide image-vs-text, and write the path into
 * that pane's PTY. Returns the target pane id on delivery, else null. The SAME
 * core as the OS file drop (`paneAtPoint` + `deliverDrop`), reached from the
 * HTML5 drag side instead of Tauri's native event — so a dragged tree row and a
 * Finder drop land in the terminal identically. `isImageOf` is injected (the
 * `paths_are_images` IPC in the app, a fake in tests).
 */
export async function deliverPathDrop(
  data: Pick<DataTransfer, "types" | "getData">,
  point: { x: number; y: number },
  rects: PaneRect[],
  isImageOf: (paths: string[]) => Promise<boolean[]>,
): Promise<string | null> {
  if (!data.types.includes(PANE_PATH_DROP_TYPE)) return null;
  const path = data.getData(PANE_PATH_DROP_TYPE);
  if (!path) return null;
  const id = paneAtPoint(point.x, point.y, rects);
  if (!id) return null;
  const isImage = await isImageOf([path]).catch(() => [false]);
  return deliverDrop(id, [path], isImage) ? id : null;
}
