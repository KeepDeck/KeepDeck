import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { tipPosition, type TipPlacement } from "./tipPlacement";

/** The generic hover/focus tip for plain-HTML surfaces (the weeks bar,
 * the achievement cards), styled like the chart's own tooltip so hover
 * answers look the same everywhere. Placement is NOT decided here — the
 * one home is [`tipPosition`], shared with the minimized-agent details:
 * measured flip, viewport clamps, whole pixels. The card portals to the
 * body (a scrolling ancestor would clip it), recomputes on scroll and
 * resize, and remeasures when its content changes while open. Reachable
 * by keyboard: the anchor is focusable and the tip is its description. */
export function Tooltip({
  tip,
  style,
  children,
}: {
  tip: ReactNode;
  /** Style for the ANCHOR — lets a caller size the hover target (the
   * weeks bar is a %-width anchor in a flex cell). */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<TipPlacement | null>(null);

  const recompute = useCallback(() => {
    const anchor = anchorRef.current;
    const card = tipRef.current;
    if (!anchor || !card) return;
    const cardRect = card.getBoundingClientRect();
    setAt(
      tipPosition({
        anchorRect: anchor.getBoundingClientRect(),
        tipWidth: cardRect.width,
        tipHeight: cardRect.height,
        viewportWidth: document.documentElement.clientWidth || window.innerWidth,
        viewportHeight:
          document.documentElement.clientHeight || window.innerHeight,
        align: "center",
      }),
    );
  }, []);

  // `tip` is a dep on purpose: content growing while open (a live ledger
  // append adds a row) must remeasure, or the card drifts off its anchor.
  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, recompute, tip]);

  return (
    <span
      ref={anchorRef}
      className="kd-tip__anchor"
      style={style}
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={tipRef}
            id={id}
            className="kd-tip"
            role="tooltip"
            style={
              at
                ? { top: at.top, left: at.left, maxHeight: at.maxHeight }
                : { top: 0, left: 0, visibility: "hidden" }
            }
          >
            {tip}
          </span>,
          document.body,
        )}
    </span>
  );
}
