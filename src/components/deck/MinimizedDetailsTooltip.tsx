import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActivityBadge } from "../../domain/status";
import { GitBranchIcon } from "../../ui/icons";
import type { GitBadge } from "../../ui/gitBadge";
import {
  calculateTooltipPosition,
  type TooltipPosition,
} from "../../ui/tooltipPlacement";

interface MinimizedDetailsTooltipProps {
  anchor: HTMLElement;
  id: string;
  title: string;
  /** The pane's live status, settled by the domain (working/waiting/done/
   * failed) — the frame colours the chip, this names the state in words. */
  activity?: ActivityBadge | null;
  gitBadge?: GitBadge | null;
  /** The pane behind the stand-in has no process. */
  stopped?: boolean;
}

/**
 * Full minimized-agent details, shown only after hover intent (or keyboard
 * focus) by MinimizedItem. The layer is portaled because the tray deliberately
 * clips overflow; fixed viewport coordinates keep the tooltip readable there
 * and inside the overflow popover alike.
 */
export function MinimizedDetailsTooltip({
  anchor,
  id,
  title,
  activity,
  gitBadge,
  stopped,
}: MinimizedDetailsTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const recompute = useCallback(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth =
      document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight =
      document.documentElement.clientHeight || window.innerHeight;
    setPosition(
      calculateTooltipPosition({
        anchorRect,
        tooltipWidth: tooltipRect.width,
        tooltipHeight: tooltipRect.height,
        viewportWidth,
        viewportHeight,
      }),
    );
  }, [anchor]);

  useLayoutEffect(() => {
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [recompute]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="minimized-tooltip"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <div className="minimized-tooltip__title">{title}</div>
      {activity && (
        <div
          className={`minimized-tooltip__status minimized-tooltip__status--${activity.tone}`}
        >
          {activity.label}
          {activity.detail ? ` — ${activity.detail}` : ""}
        </div>
      )}
      {/* The chip's own marker is a glyph with a native `title`, which this
          custom tooltip suppresses on the same hover — so the detail layer has
          to carry the state itself or the hover hides what it explains. */}
      {stopped && <div className="minimized-tooltip__stopped">Stopped</div>}
      {gitBadge && (
        <div className="minimized-tooltip__branch">
          <GitBranchIcon />
          <span>{gitBadge.title}</span>
        </div>
      )}
    </div>,
    anchor.ownerDocument.body,
  );
}
