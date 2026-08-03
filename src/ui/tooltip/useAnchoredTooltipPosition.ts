import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  calculateTooltipPosition,
  type TooltipPosition,
} from "../tooltipPlacement";

export type TooltipAnchorRect = Pick<DOMRect, "top" | "bottom" | "left"> & {
  right?: number;
};

interface AnchoredTooltipPositionInput {
  ownerDocument: Document;
  getAnchorRect(): TooltipAnchorRect | null;
  /** Forwarded to the placement rule; see [`calculateTooltipPosition`]. */
  align?: "start" | "center";
}

/** Own the browser synchronization required by fixed, portaled tooltips. */
export function useAnchoredTooltipPosition({
  ownerDocument,
  getAnchorRect,
  align,
}: AnchoredTooltipPositionInput) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const recompute = useCallback(() => {
    const tooltip = tooltipRef.current;
    const anchorRect = getAnchorRect();
    if (!tooltip || anchorRect === null) {
      setPosition(null);
      return;
    }

    const tooltipRect = tooltip.getBoundingClientRect();
    const viewport = ownerDocument.defaultView;
    const viewportWidth =
      ownerDocument.documentElement.clientWidth || viewport?.innerWidth || 0;
    const viewportHeight =
      ownerDocument.documentElement.clientHeight || viewport?.innerHeight || 0;
    setPosition(
      calculateTooltipPosition({
        anchorRect,
        tooltipWidth: tooltipRect.width,
        tooltipHeight: tooltipRect.height,
        viewportWidth,
        viewportHeight,
        align,
      }),
    );
  }, [align, getAnchorRect, ownerDocument]);

  useLayoutEffect(() => {
    recompute();
    const viewport = ownerDocument.defaultView;
    // The layer itself may GROW while open (a live ledger append adds a
    // row) — remeasure on its own resize, not only on viewport events.
    const observer =
      viewport && "ResizeObserver" in viewport && tooltipRef.current
        ? new viewport.ResizeObserver(recompute)
        : null;
    if (observer && tooltipRef.current) observer.observe(tooltipRef.current);
    viewport?.addEventListener("scroll", recompute, true);
    viewport?.addEventListener("resize", recompute);
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener("scroll", recompute, true);
      viewport?.removeEventListener("resize", recompute);
    };
  }, [ownerDocument, recompute]);

  return { tooltipRef, position };
}
