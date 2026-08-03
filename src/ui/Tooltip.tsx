import { useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** THE hover tip — one primitive for every plain-HTML surface that owes
 * the cursor a detail card (the weeks bar today; whatever hovers next),
 * styled like the chart's own tooltip so hover answers look the same
 * everywhere.
 *
 * The tip PORTALS to the body at fixed viewport coordinates: rendered in
 * place it would clip against any scrolling ancestor (the stats dialog's
 * body ate the first row's tip). Above the anchor by default, flipped
 * below when the anchor sits too close to the viewport top. Pure
 * presentation state; the tip is not interactive. */
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
      }}
      onMouseLeave={() => setAt(null)}
    >
      {children}
      {at !== null &&
        createPortal(
          <span
            className="kd-tip"
            role="tooltip"
            style={{
              left: at.x,
              top: at.y,
              transform: `translate(-50%, ${at.below ? "0" : "-100%"})`,
            }}
          >
            {tip}
          </span>,
          document.body,
        )}
    </span>
  );
}
