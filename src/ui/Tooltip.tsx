import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAnchoredTooltipPosition } from "./tooltip/useAnchoredTooltipPosition";

/** The one open tip's closer — a hover layer is a spotlight, and two at
 * once (a focused anchor plus a hovered one) read as a glitch: opening
 * any tip closes whichever other one is up. */
let closeOpenTip: (() => void) | null = null;

/** The generic hover tip for plain-HTML surfaces (the weeks bar, the
 * achievement cards), styled like the chart's own tooltip so hover
 * answers look the same everywhere. Placement and browser sync are NOT
 * decided here — [`calculateTooltipPosition`] via
 * [`useAnchoredTooltipPosition`] is the one home shared with the
 * minimized-agent details and the burn inspector. The card portals to
 * the body (a scrolling ancestor would clip it). */
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
  const enterTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

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

  const getAnchorRect = useCallback(
    () => anchorRef.current?.getBoundingClientRect() ?? null,
    [],
  );

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
      // A press ends the question the tip was answering. It stays on the
      // anchor after a click — the pointer has not moved — and whatever the
      // press opened arrives UNDER it: a menu button's own menu came up
      // behind its explanation. Nothing the tip could say is worth covering
      // the thing the user just asked for.
      //
      // On pointerdown rather than click, so the tip is gone before the menu
      // paints, and in the capture phase so a child that stops the event
      // (a button minding its own press) cannot leave the card standing.
      onPointerDownCapture={() => {
        cancelEnter();
        hide();
      }}
    >
      {children}
      {open && <TipLayer id={id} getAnchorRect={getAnchorRect} tip={tip} />}
    </span>
  );
}

/** The portaled layer — its own component so the anchored-position hook
 * (and its window listeners) exists exactly as long as the card does. */
function TipLayer({
  id,
  getAnchorRect,
  tip,
}: {
  id: string;
  getAnchorRect(): DOMRect | null;
  tip: ReactNode;
}) {
  const { tooltipRef, position } = useAnchoredTooltipPosition({
    ownerDocument: document,
    getAnchorRect,
    align: "center",
  });
  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className="kd-tip"
      role="tooltip"
      style={
        position
          ? {
              top: position.top,
              left: position.left,
              maxHeight: position.maxHeight,
            }
          : { top: 0, left: 0, visibility: "hidden" }
      }
    >
      {tip}
    </div>,
    document.body,
  );
}
