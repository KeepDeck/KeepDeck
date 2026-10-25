import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { calculateFloatingListboxPlacement } from "@keepdeck/ui-kit/FloatingListbox";
import { helpView } from "../helpView";
import { formatChord } from "../binding";
import { runtime } from "../runtime";

/** The app's stroke-icon grammar (ui-kit iconProps): the info glyph, which
 * ui-kit's icon set does not carry. */
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
  const { bindings: bindingsStore } = runtime();
  const bindings = useSyncExternalStore(
    bindingsStore.subscribe,
    bindingsStore.snapshot,
  );
  const help = helpView(formatChord(bindings.command), formatChord(bindings.dictation));

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    // The app's one floating geometry (ui-kit): below the trigger, flipped
    // above when the viewport runs out, kept inside its margins. The card is
    // right-aligned to the trigger, so its box starts WIDTH left of the
    // trigger's right edge; it is never clipped to a list's max height.
    const place = calculateFloatingListboxPlacement({
      anchorRect: {
        top: rect.top,
        bottom: rect.bottom,
        right: rect.right,
        left: rect.right - WIDTH,
        width: WIDTH,
      },
      listHeight: cardRef.current?.offsetHeight ?? 0,
      contentWidth: WIDTH,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      maxHeight: Number.POSITIVE_INFINITY,
    });
    setPos({ top: place.top, left: place.left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const target = e.target instanceof Node ? e.target : null;
      if (card.contains(target) || anchor.contains(target)) return;
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
      className="voice__help kd-float"
      role="dialog"
      aria-label={help.label}
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
        <kbd>{help.command.keys}</kbd>
        {help.command.text}
      </div>
      <ul className="voice__help-list">
        {help.commands.map((cmd) => (
          <li key={cmd.template}>
            {cmd.parts.map((part, i) =>
              part.slot ? (
                <span key={i} className="voice__help-slot">
                  {part.text}
                </span>
              ) : (
                part.text
              ),
            )}
          </li>
        ))}
      </ul>
      <div className="voice__help-row">
        <kbd>{help.dictation.keys}</kbd>
        {help.dictation.text}
      </div>
      <div className="voice__help-row">
        <kbd>{help.escape.keys}</kbd>
        {help.escape.text}
      </div>
      <div className="voice__help-note">{help.note}</div>
    </div>,
    document.body,
  );
}
