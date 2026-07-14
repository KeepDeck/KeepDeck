import { describe, expect, it } from "vitest";
import { calculateMinimizedTooltipPosition } from "./MinimizedDetailsTooltip";

const anchor = {
  top: 40,
  right: 140,
  bottom: 66,
  left: 40,
};

describe("calculateMinimizedTooltipPosition", () => {
  it("places normal content below when there is no room above", () => {
    expect(
      calculateMinimizedTooltipPosition({
        anchorRect: anchor,
        tooltipWidth: 200,
        tooltipHeight: 50,
        viewportWidth: 500,
        viewportHeight: 300,
      }),
    ).toEqual({ top: 72, left: 40, maxHeight: 284 });
  });

  it("caps pathological content and keeps the whole layer inside the viewport", () => {
    expect(
      calculateMinimizedTooltipPosition({
        anchorRect: anchor,
        tooltipWidth: 900,
        tooltipHeight: 1000,
        viewportWidth: 400,
        viewportHeight: 120,
      }),
    ).toEqual({ top: 8, left: 8, maxHeight: 104 });
  });
});
