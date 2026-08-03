import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { tipPosition, type TipPlacement } from "./tipPlacement";

/** The one open tip's closer — a hover layer is a spotlight, and two at
 * once (a focused anchor plus a hovered one) read as a glitch: opening
 * any tip closes whichever other one is up. */
let closeOpenTip: (() => void) | null = null;

/** The generic hover tip for plain-HTML surfaces (the weeks bar, the
 * achievement cards), styled like the chart's own tooltip so hover
 * answers look the same everywhere. Placement is NOT decided here — the
 * one home is [`tipPosition`], shared with the minimized-agent details:
 * measured flip, viewport clamps, whole pixels. The card portals to the
 * body (a scrolling ancestor would clip it), recomputes on scroll and
 * resize, and remeasures itself when its content grows while open. */
export function Tooltip({
  tip,
  className,
  style,
  delayMs = 0,
  focusable = false,
  children,
}: {
  tip: ReactNode;
  /** Class/style for the ANCHOR — a caller may size the hover target
   * (the weeks bar is a %-width anchor) or BE a styled card that owns
   * its tip (the achievement cards). */
  className?: string;
  style?: CSSProperties;
  /** Hover intent: how long the cursor must rest before the card shows.
   * A grid swept by the mouse (achievements) wants a pause; a lone bar
   * answers instantly. Focus, when enabled, always opens immediately. */
  delayMs?: number;
  /** Opt-in keyboard access: the anchor joins the tab order and the tip
   * becomes its description. Deliberately NOT the default — a grid of
   * fifty cards would flood the tab order with generic stops; a handful
   * of bars will not. */
  focusable?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const enterTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<TipPlacement | null>(null);

  const cancelEnter = () => {
    if (enterTimer.current !== null) {
      clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
  };
  const hide = useCallback(function hideTip() {
    setOpen(false);
    if (closeOpenTip === hideTip) closeOpenTip = null;
  }, []);
  const show = useCallback(() => {
    closeOpenTip?.();
    closeOpenTip = hide;
    setOpen(true);
  }, [hide]);
  useEffect(
    () => () => {
      cancelEnter();
      if (closeOpenTip === hide) closeOpenTip = null;
    },
    [hide],
  );

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

  // The ResizeObserver carries content growth (a live ledger append adds
  // a row to an open tip) without putting the tip node in the deps — an
  // inline `tip` changes identity on every PARENT render and would churn
  // the window listeners once per wall-clock tick.
  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    const card = tipRef.current;
    const observer =
      typeof ResizeObserver !== "undefined" && card
        ? new ResizeObserver(recompute)
        : null;
    if (observer && card) observer.observe(card);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open, recompute]);

  return (
    <span
      ref={anchorRef}
      className={`kd-tip__anchor${className ? ` ${className}` : ""}`}
      style={style}
      {...(focusable
        ? {
            tabIndex: 0,
            "aria-describedby": open ? id : undefined,
            onFocus: () => {
              cancelEnter();
              show();
            },
            onBlur: hide,
          }
        : {})}
      onMouseEnter={() => {
        if (delayMs > 0) {
          enterTimer.current = window.setTimeout(show, delayMs);
        } else {
          show();
        }
      }}
      onMouseLeave={() => {
        cancelEnter();
        // A focus-opened tip belongs to the FOCUS: brushing the cursor
        // across the anchor must not steal it from the keyboard.
        if (anchorRef.current !== document.activeElement) hide();
      }}
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
