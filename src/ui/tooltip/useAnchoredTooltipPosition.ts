import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  calculateTooltipPosition,
  type TooltipPosition,
} from "../tooltipPlacement";

export type TooltipAnchorRect = Pick<DOMRect, "top" | "bottom" | "left">;

interface AnchoredTooltipPositionInput {
  ownerDocument: Document;
  getAnchorRect(): TooltipAnchorRect | null;
}

/** Own the browser synchronization required by fixed, portaled tooltips. */
export function useAnchoredTooltipPosition({
  ownerDocument,
  getAnchorRect,
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
      }),
    );
  }, [getAnchorRect, ownerDocument]);

  useLayoutEffect(() => {
    recompute();
    const viewport = ownerDocument.defaultView;
    viewport?.addEventListener("scroll", recompute, true);
    viewport?.addEventListener("resize", recompute);
    return () => {
      viewport?.removeEventListener("scroll", recompute, true);
      viewport?.removeEventListener("resize", recompute);
    };
  }, [ownerDocument, recompute]);

  return { tooltipRef, position };
}
