/**
 * Place a transient hint next to its anchor — the point that was clicked
 * ([F16]). Pure math (sizes in, offsets out) so the placement rules are
 * unit-testable without a DOM.
 *
 * Rules: centered horizontally on the anchor, GAP below it; flips above when
 * the pane's bottom edge would clip it; always kept MARGIN inside the pane.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Distance from the anchor, clearing the pointer and the clicked glyph. */
const GAP = 12;
/** Minimum inset from the pane edges. */
const MARGIN = 8;

export function positionHint(
  anchor: Point,
  hint: Size,
  pane: Size,
): { left: number; top: number } {
  const left = clamp(
    anchor.x - hint.width / 2,
    MARGIN,
    // A pane narrower than the hint pins to the left margin (max-width CSS
    // keeps the hint itself inside).
    Math.max(MARGIN, pane.width - hint.width - MARGIN),
  );

  const below = anchor.y + GAP;
  const fitsBelow = below + hint.height <= pane.height - MARGIN;
  const top = fitsBelow ? below : Math.max(MARGIN, anchor.y - GAP - hint.height);

  return { left, top };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
