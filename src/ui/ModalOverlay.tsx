import { dropBlocker } from "@keepdeck/ui-kit/dropBlocker";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MODAL_OVERLAY_CLASS, inertBackground } from "./inertBackground";

/**
 * Full-window blocking backdrop for dialogs. Portaled to `document.body` so it
 * covers the ENTIRE app — top bar, workspaces sidebar, and deck alike — rather
 * than only the deck stage the dialog is spawned from. That full coverage is
 * what blocks interaction with everything behind the dialog (the backdrop eats
 * the clicks). Children are centered on the backdrop; styling lives in the
 * `.modal-overlay` rule.
 *
 * Eating clicks is not enough to stop a FILE drop: an OS drop arrives from the
 * window as raw coordinates and never consults the DOM, so without the blocker
 * marker a path dragged from Finder onto an open dialog would be typed into a
 * pane behind the backdrop.
 *
 * Nor is it enough to stop the KEYBOARD, which reaches a pane without ever
 * touching the backdrop — see [`inertBackground`], applied here because this
 * is the one shell every dialog is built on.
 */
export function ModalOverlay({ children }: { children: ReactNode }) {
  const layerRef = useRef<HTMLDivElement>(null);

  // Layout effect: the backdrop is on screen from the frame it paints, so the
  // background must be inert from that same frame — an effect deferred past
  // paint leaves a window in which the pane behind still answers the keyboard.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    return inertBackground(layer);
  }, []);

  return createPortal(
    <div ref={layerRef} className={MODAL_OVERLAY_CLASS} {...dropBlocker()}>
      {children}
    </div>,
    document.body,
  );
}
