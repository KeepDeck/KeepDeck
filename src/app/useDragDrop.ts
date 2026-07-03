import { useEffect, useRef } from "react";
import { paneAtPoint } from "../domain/dnd";
import { pathsAreImages } from "../ipc/app";
import { describeError, log } from "../ipc/log";
import { onFileDrop } from "../ipc/webview";
import { collectPaneRects, deliverDrop } from "./dragDrop";

/**
 * Deliver OS file drops to the pane under the cursor ([F4]): hit-test the drop
 * point against the active grid's pane rects, ask the backend which paths are
 * images (bracketed-pasted so the agent attaches them; others inserted raw),
 * and write into that pane's PTY. `onDropped` fires with the pane id after a
 * successful delivery so the caller can focus the pane.
 */
export function useDragDrop(onDropped: (paneId: string) => void) {
  // Latest callback for the mount-once listener — it closes over render state.
  const droppedRef = useRef(onDropped);
  droppedRef.current = onDropped;

  useEffect(() => {
    // Kill the WKWebView's native "insert dropped text into the focused field"
    // behaviour. For OS file drops it doesn't surface as a DOM drop event, but
    // it DOES fire a beforeinput with inputType 'insertFromDrop' on the focused
    // xterm textarea — that second copy landed in the focused pane. Cancel it
    // (capture) so only our routed insertion remains.
    const blockDropInsert = (e: Event) => {
      if ((e as InputEvent).inputType === "insertFromDrop") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("beforeinput", blockDropInsert, true);

    // The cancelled flag keeps a StrictMode double-mount from leaving two
    // listeners behind.
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    onFileDrop(async ({ x, y, paths }) => {
      const id = paneAtPoint(x, y, collectPaneRects());
      if (!id) return;
      const isImage = await pathsAreImages(paths).catch((e) => {
        log.debug("web:dnd", `image sniff failed, treating drop as text: ${describeError(e)}`);
        return paths.map(() => false);
      });
      if (deliverDrop(id, paths, isImage)) droppedRef.current(id);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) =>
        log.warn("web:dnd", `file-drop listener failed to attach: ${describeError(e)}`),
      );

    return () => {
      cancelled = true;
      document.removeEventListener("beforeinput", blockDropInsert, true);
      unlisten?.();
    };
  }, []);
}
