import { useEffect, useRef } from "react";
import { pathsAreImages } from "../ipc/app";
import { collectPaneRects, deliverPathDrop, PANE_PATH_DROP_TYPE } from "./dragDrop";

/**
 * Deliver IN-APP path drags to the pane under the cursor. A drag source (the
 * Files plugin's tree) puts a file path on the drag's dataTransfer under
 * `PANE_PATH_DROP_TYPE`; dropping it anywhere over a pane writes the path into
 * that pane's PTY — the same delivery the OS file drop uses (`useDragDrop`),
 * only reached from HTML5 drag events instead of Tauri's native drop.
 *
 * Document-level and point-hit-tested (not per-pane handlers), mirroring the OS
 * drop, so it works over the xterm canvas without the panes knowing about it.
 * The type gate means non-file drags — e.g. a dragged text selection — pass
 * straight through. `onDropped` fires with the pane id so the caller can focus.
 */
export function usePaneDrop(onDropped: (paneId: string) => void) {
  const droppedRef = useRef(onDropped);
  droppedRef.current = onDropped;

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(PANE_PATH_DROP_TYPE)) return;
      // preventDefault marks the document a valid drop target so `drop` fires;
      // the copy cursor signals a non-destructive drop.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(PANE_PATH_DROP_TYPE)) return;
      event.preventDefault();
      void deliverPathDrop(
        event.dataTransfer,
        { x: event.clientX, y: event.clientY },
        collectPaneRects(),
        pathsAreImages,
      ).then((id) => {
        if (id) droppedRef.current(id);
      });
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
}
