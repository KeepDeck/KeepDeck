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
    const release = inertBackground(layer);
    // Making the background inert BLURS whatever it held, which leaves the
    // keyboard on <body> — the dialog is up and nothing in it can be typed
    // into or tabbed through. Take it, unless the dialog already placed it:
    // some autofocus their own control, and stealing it back would undo a
    // deliberate choice. The same test as [`Peek`]'s.
    if (!layer.contains(document.activeElement)) {
      layer.focus({ preventScroll: true });
    }
    return release;
    // Deliberately no restore on the way out: the app already has one owner
    // of where focus lands when a dialog closes — the pane's own focus
    // effect, which reacts to `keyboardFocusEnabled` coming back. A second
    // claimant here would race it.
  }, []);

  return createPortal(
    // tabIndex so the layer itself can hold the keyboard for a dialog with
    // nothing focusable of its own yet (a form still loading its options).
    <div
      ref={layerRef}
      className={MODAL_OVERLAY_CLASS}
      tabIndex={-1}
      {...dropBlocker()}
    >
      {children}
    </div>,
    document.body,
  );
}
