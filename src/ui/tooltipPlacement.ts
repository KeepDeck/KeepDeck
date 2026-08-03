const TOOLTIP_GAP = 6;
const VIEWPORT_MARGIN = 8;

export interface TooltipPosition {
  top: number;
  left: number;
  maxHeight: number;
}

export interface TooltipPlacementInput {
  /** `right` is optional: point anchors (the burn cursor) have none, and
   * centering falls back to the left edge — correct for a point. */
  anchorRect: Pick<DOMRect, "top" | "bottom" | "left"> & { right?: number };
  tooltipWidth: number;
  tooltipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Horizontal anchoring: `start` aligns the layer's left edge with the
   * anchor's (details cards), `center` centers it on the anchor (the
   * weeks bar). Both obey the viewport clamp. */
  align?: "start" | "center";
}

/** THE placement rule for every anchored hover layer: above when the
 * MEASURED height fits, otherwise below; clamped to the viewport on both
 * axes; height capped; landed on WHOLE pixels — a layer on a half-pixel
 * blurs its text. */
export function calculateTooltipPosition({
  anchorRect,
  tooltipWidth,
  tooltipHeight,
  viewportWidth,
  viewportHeight,
  align = "start",
}: TooltipPlacementInput): TooltipPosition {
  const maxWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2);
  const renderedWidth = Math.min(Math.max(0, tooltipWidth), maxWidth);
  const renderedHeight = Math.min(Math.max(0, tooltipHeight), maxHeight);
  const desiredLeft =
    align === "center"
      ? (anchorRect.left + (anchorRect.right ?? anchorRect.left)) / 2 -
        renderedWidth / 2
      : anchorRect.left;
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(desiredLeft, viewportWidth - renderedWidth - VIEWPORT_MARGIN),
  );
  const above = anchorRect.top - TOOLTIP_GAP - renderedHeight;
  const top =
    above >= VIEWPORT_MARGIN
      ? above
      : Math.min(
          viewportHeight - renderedHeight - VIEWPORT_MARGIN,
          anchorRect.bottom + TOOLTIP_GAP,
        );

  return {
    top: Math.round(Math.max(VIEWPORT_MARGIN, top)),
    left: Math.round(left),
    maxHeight,
  };
}
