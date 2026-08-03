/**
 * THE placement rule for hover layers — where a portaled, fixed-position
 * card lands relative to its anchor. One pure home shared by every tip
 * (the generic Tooltip, the minimized-agent details): above the anchor
 * when the MEASURED height fits, below otherwise, clamped to the viewport
 * on both axes, capped in height, and landed on WHOLE pixels — a card on
 * a half-pixel blurs its text.
 */

const GAP = 6;
const VIEWPORT_MARGIN = 8;

export interface TipPlacement {
  top: number;
  left: number;
  maxHeight: number;
}

export interface TipPlacementInput {
  anchorRect: Pick<DOMRect, "top" | "right" | "bottom" | "left">;
  tipWidth: number;
  tipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Horizontal anchor: `start` aligns the card's left edge with the
   * anchor's (the minimized details), `center` centers it on the anchor
   * (the weeks bar). Both obey the viewport clamp. */
  align?: "start" | "center";
}

export function tipPosition({
  anchorRect,
  tipWidth,
  tipHeight,
  viewportWidth,
  viewportHeight,
  align = "start",
}: TipPlacementInput): TipPlacement {
  const maxWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2);
  const renderedWidth = Math.min(Math.max(0, tipWidth), maxWidth);
  const renderedHeight = Math.min(Math.max(0, tipHeight), maxHeight);
  const desiredLeft =
    align === "center"
      ? (anchorRect.left + anchorRect.right) / 2 - renderedWidth / 2
      : anchorRect.left;
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(desiredLeft, viewportWidth - renderedWidth - VIEWPORT_MARGIN),
  );
  const above = anchorRect.top - GAP - renderedHeight;
  const top =
    above >= VIEWPORT_MARGIN
      ? above
      : Math.min(
          viewportHeight - renderedHeight - VIEWPORT_MARGIN,
          anchorRect.bottom + GAP,
        );

  return {
    top: Math.round(Math.max(VIEWPORT_MARGIN, top)),
    left: Math.round(left),
    maxHeight,
  };
}
