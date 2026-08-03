const TOOLTIP_GAP = 6;
const VIEWPORT_MARGIN = 8;

export interface TooltipPosition {
  top: number;
  left: number;
  maxHeight: number;
}

export interface TooltipPlacementInput {
  anchorRect: Pick<DOMRect, "top" | "bottom" | "left">;
  tooltipWidth: number;
  tooltipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Place an anchored tooltip above when possible, otherwise below, while
 * keeping even pathological content inside the visible viewport. */
export function calculateTooltipPosition({
  anchorRect,
  tooltipWidth,
  tooltipHeight,
  viewportWidth,
  viewportHeight,
}: TooltipPlacementInput): TooltipPosition {
  const maxWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2);
  const renderedWidth = Math.min(Math.max(0, tooltipWidth), maxWidth);
  const renderedHeight = Math.min(Math.max(0, tooltipHeight), maxHeight);
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      anchorRect.left,
      viewportWidth - renderedWidth - VIEWPORT_MARGIN,
    ),
  );
  const above = anchorRect.top - TOOLTIP_GAP - renderedHeight;
  const top =
    above >= VIEWPORT_MARGIN
      ? above
      : Math.min(
          viewportHeight - renderedHeight - VIEWPORT_MARGIN,
          anchorRect.bottom + TOOLTIP_GAP,
        );

  return { top: Math.max(VIEWPORT_MARGIN, top), left, maxHeight };
}
