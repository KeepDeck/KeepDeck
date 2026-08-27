/**
 * Where the account panel hangs.
 *
 * It used to hang off the whole chip row: absolutely positioned against the
 * group with `right: 0`, so it sat at the row's right edge no matter which
 * account was open, and switching from one chip to the next moved nothing.
 * A panel that does not follow its trigger stops reading as that trigger's
 * answer — it reads as a fixture that happens to change contents.
 *
 * So the panel follows the OPEN CHIP, and the only question left is what to do
 * when following it would push the panel off the window. That question is the
 * whole of this module, and it is arithmetic — no DOM, no React.
 */

/** Air kept between the panel and the window edge. */
export const USAGE_PANEL_VIEWPORT_MARGIN = 8;

export interface UsagePanelPlacementInput {
  /** The open chip's left edge, in viewport pixels. */
  chipLeft: number;
  /** The chip group's left edge — the panel is positioned inside it, so the
   *  answer is returned relative to this. */
  groupLeft: number;
  panelWidth: number;
  viewportWidth: number;
  margin?: number;
}

/**
 * The panel's `left`, in pixels from the chip group's own left edge.
 *
 * Aligned to the chip's left edge, which is where the eye already is. Pushed
 * back only as far as the window forces: a chip near the right edge would
 * otherwise trail its panel off-screen, and the panel losing its left
 * alignment is a smaller lie than the panel being unreadable.
 *
 * A window narrower than the panel itself resolves to the leading margin —
 * clipped on the right rather than centred on nothing.
 *
 * Pure.
 */
export function usagePanelLeft({
  chipLeft,
  groupLeft,
  panelWidth,
  viewportWidth,
  margin = USAGE_PANEL_VIEWPORT_MARGIN,
}: UsagePanelPlacementInput): number {
  const furthestLeft = viewportWidth - margin - panelWidth;
  const inViewport = Math.max(margin, Math.min(chipLeft, furthestLeft));
  return inViewport - groupLeft;
}
