import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The app's stroke-icon grammar (ui-kit iconProps), drawn locally: a plugin
 * bundles no ui-kit just for one glyph. */
export function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

const GAP = 4;
const MARGIN = 8;
const WIDTH = 280;

/**
 * A floating help card anchored to its trigger — portaled to the body at
 * viewport coordinates (the dock clips overflow; pushing content into the
 * tab column is not an option). Closes on outside pointerdown or Escape.
 */
export function HelpPopover({
  anchor,
  onClose,
  onPointerStay,
  onPointerLeave,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  /** Cursor entered the card — a hover-triggered popover must not close
   * while it is being read. */
  onPointerStay?: () => void;
  onPointerLeave?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = cardRef.current?.offsetHeight ?? 0;
    const left = Math.max(
      MARGIN,
      Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - MARGIN),
    );
    // Prefer below the trigger; flip above when the viewport runs out.
    const below = rect.bottom + GAP;
    const top =
      below + height + MARGIN <= window.innerHeight
        ? below
        : Math.max(MARGIN, rect.top - GAP - height);
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (card.contains(e.target as Node) || anchor.contains(e.target as Node))
        return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={cardRef}
      className="voice__help"
      role="dialog"
      aria-label="How to use voice"
      onMouseEnter={onPointerStay}
      onMouseLeave={onPointerLeave}
      style={{
        width: WIDTH,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="voice__help-row">
        <kbd>⌥Space</kbd> hold — speak a command, released = executed
      </div>
      <div className="voice__help-ex">
        “create an agent in KeepDeck with task run the tests” · “switch to
        Website” · “close the latest agent” · «запусти нового агента» ·
        «перейди на KeepDeck» · «закрой последнего агента»
      </div>
      <div className="voice__help-row">
        <kbd>⌥⇧Space</kbd> hold — dictate into the focused agent, released =
        sent
      </div>
      <div className="voice__help-row">
        <kbd>Esc</kbd> while holding — cancel
      </div>
    </div>,
    document.body,
  );
}
