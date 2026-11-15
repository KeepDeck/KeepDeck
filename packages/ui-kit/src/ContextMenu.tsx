/**
 * A menu opened by a right-click, at the pointer.
 *
 * The same list `MenuButton` opens (`MenuList`) — the same items, the same
 * keyboard walk, the same way of letting go — anchored at a point instead
 * of a button. The point is a zero-size box portaled to the page at the
 * pointer, so the floating layer's placement (flipping, clamping to the
 * viewport) works on it unchanged, whatever transforms the element that was
 * clicked sits under.
 *
 * Mounted while open; the caller drops it on `onClose`. Going away by a
 * press or a focus elsewhere is `useAwayClose`'s, as for every menu here.
 */
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { MenuList, type MenuAction } from "./MenuButton";
import { useAwayClose } from "./useAwayClose";

export interface ContextMenuProps {
  /** Where the pointer opened it, in viewport pixels. */
  at: { x: number; y: number };
  actions: readonly MenuAction[];
  /** Names the menu. */
  ariaLabel: string;
  onClose(): void;
}

export function ContextMenu({ at, actions, ariaLabel, onClose }: ContextMenuProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const id = useId();
  // Where focus was when it opened: a pick or an Escape puts it back, as
  // the button menu does for its trigger.
  const returnTo = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // Once: putting focus back is itself a focus elsewhere, which the
  // away-close would otherwise answer with a second close.
  const closed = useRef(false);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };
  useAwayClose(true, close, anchorRef, listRef);

  const closeAndRestore = () => {
    close();
    returnTo.current?.focus();
  };

  return (
    <>
      {createPortal(
        <span
          ref={anchorRef}
          className="kd-context-menu__anchor"
          style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }}
          aria-hidden
        />,
        document.body,
      )}
      {actions.length > 0 && (
        <MenuList
          anchorRef={anchorRef}
          listRef={listRef}
          id={id}
          ariaLabel={ariaLabel}
          actions={actions}
          onClose={closeAndRestore}
        />
      )}
    </>
  );
}
