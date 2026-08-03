import { useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** THE hover tip — one primitive for every plain-HTML surface that owes
 * the cursor a detail card (the weeks bar today; whatever hovers next),
 * styled like the chart's own tooltip so hover answers look the same
 * everywhere.
 *
 * The tip PORTALS to the body at fixed viewport coordinates: rendered in
 * place it would clip against any scrolling ancestor (the stats dialog's
 * body ate the first row's card). It mounts hidden, measures itself, and
 * lands on WHOLE pixels — a translate(-50%) of an odd-width card sat the
 * text on a half-pixel and blurred it. Above the anchor by default,
 * flipped below near the viewport top. Not interactive by design. */
export function Tooltip({
  tip,
  className,
  style,
  children,
}: {
  tip: ReactNode;
  /** Extra class/style for the ANCHOR — lets a caller size the hover
   * target (the weeks bar is a %-width anchor in a flex cell). */
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(
    null,
  );
  const [box, setBox] = useState<{ width: number; height: number } | null>(
    null,
  );
  const measure = (tipEl: HTMLSpanElement | null) => {
    if (tipEl && box === null) {
      setBox({ width: tipEl.offsetWidth, height: tipEl.offsetHeight });
    }
  };
  return (
    <span
      className={`kd-tip__anchor${className ? ` ${className}` : ""}`}
      style={style}
      onMouseEnter={(mouse) => {
        const rect = mouse.currentTarget.getBoundingClientRect();
        const below = rect.top < 120;
        setAt({
          x: rect.left + rect.width / 2,
          y: below ? rect.bottom + 8 : rect.top - 8,
          below,
        });
        setBox(null);
      }}
      onMouseLeave={() => setAt(null)}
    >
      {children}
      {at !== null &&
        createPortal(
          <span
            ref={measure}
            className="kd-tip"
            role="tooltip"
            style={
              box === null
                ? { left: 0, top: 0, visibility: "hidden" }
                : {
                    left: Math.round(at.x - box.width / 2),
                    top: Math.round(at.below ? at.y : at.y - box.height),
                  }
            }
          >
            {tip}
          </span>,
          document.body,
        )}
    </span>
  );
}
