import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranchIcon } from "../../ui/icons";
import type { GitBadge } from "../../ui/gitBadge";

const GAP = 6;
const VIEWPORT_MARGIN = 8;

interface TooltipPosition {
  top: number;
  left: number;
}

interface MinimizedDetailsTooltipProps {
  anchor: HTMLElement;
  id: string;
  title: string;
  gitBadge?: GitBadge | null;
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
  gitBadge,
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
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        anchorRect.left,
        viewportWidth - tooltipRect.width - VIEWPORT_MARGIN,
      ),
    );
    const above = anchorRect.top - GAP - tooltipRect.height;
    const top =
      above >= VIEWPORT_MARGIN
        ? above
        : Math.min(
            viewportHeight - tooltipRect.height - VIEWPORT_MARGIN,
            anchorRect.bottom + GAP,
          );

    setPosition({ top: Math.max(VIEWPORT_MARGIN, top), left });
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
        visibility: position ? "visible" : "hidden",
      }}
    >
      <div className="minimized-tooltip__title">{title}</div>
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
