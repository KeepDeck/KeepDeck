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
 * touching the backdrop — see [`inertBackground`], applied here because this
 * is the one shell every dialog is built on. This shell does not DECIDE that a
 * dialog owns the keyboard; the app decided that upstream when it opened one.
 * It enforces it in the DOM, which is the only place the enforcement can live.
 */
export function ModalOverlay({ children }: { children: ReactNode }) {
  const layerRef = useRef<HTMLDivElement>(null);

  // Layout effect: the backdrop is on screen from the frame it paints, so the
  // background must be inert from that same frame — an effect deferred past
  // paint leaves a window in which the pane behind still answers the keyboard.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    // Where the keyboard was before we took it. A dialog that autofocuses its
    // own control has already done so by now (React commits `autoFocus`
    // child-first), so anything inside the layer is OUR doing and not a place
    // to give focus back to.
    const previous = document.activeElement;
    const restoreTo =
      previous instanceof HTMLElement && !layer.contains(previous)
        ? previous
        : null;

    const release = inertBackground(layer);
    // Making the background inert BLURS whatever it held, which leaves the
    // keyboard on <body> — the dialog is up and nothing in it can be typed
    // into or tabbed through. Take it, unless the dialog already placed it:
    // some autofocus their own control, and stealing it back would undo a
    // deliberate choice. The same test as [`Peek`]'s.
    if (!layer.contains(document.activeElement)) {
      layer.focus({ preventScroll: true });
    }

    return () => {
      release();
      // Hand the keyboard back where we found it. Only while WE still hold it:
      // the pane's own focus effect runs after this cleanup and must win when
      // it applies, and any other surface that claimed focus in the meantime
      // outranks a restore. Without this the keyboard is simply dropped — the
      // pane reclaims it only when one is selected, visible and allowed it,
      // and on every other close path focus was left on <body>.
      if (!layer.contains(document.activeElement)) return;
      if (restoreTo?.isConnected) restoreTo.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    // tabIndex so the layer itself can hold the keyboard for a dialog with
    // nothing focusable of its own yet (a form still loading its options).
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
