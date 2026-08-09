import { dropBlocker } from "@keepdeck/ui-kit/dropBlocker";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { inertBackground } from "./inertBackground";

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
 * touching the backdrop — see [`inertBackground`], which this shell pushes
 * itself onto. It is the shell all of the app's OWN dialogs are built on, but
 * not every modal surface in the tree: ui-kit's `Peek` is a full-window
 * `aria-modal` panel that deliberately renders in place instead of portaling,
 * and pushes no layer.
 *
 * This shell decides nothing. The app decided a dialog owns the keyboard when
 * it opened one; the layer stack owns where that keyboard actually sits, in
 * both directions, because only it knows whether another layer is underneath.
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
    // tabIndex so the layer can hold the keyboard for a dialog that focuses
    // nothing of its own — three of them do not.
    <div
      ref={layerRef}
      className="modal-overlay"
      tabIndex={-1}
      {...dropBlocker()}
    >
      {children}
    </div>,
    document.body,
  );
}
