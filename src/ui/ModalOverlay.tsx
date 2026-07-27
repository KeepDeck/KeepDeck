import { dropBlocker } from "@keepdeck/ui-kit/dropBlocker";
import { type ReactNode } from "react";
import { createPortal } from "react-dom";

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
 */
export function ModalOverlay({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="modal-overlay" {...dropBlocker()}>
      {children}
    </div>,
    document.body,
  );
}
