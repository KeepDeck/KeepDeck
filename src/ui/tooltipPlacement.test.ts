import { describe, expect, it } from "vitest";
import { calculateTooltipPosition } from "./tooltipPlacement";

const anchor = {
  top: 40,
  bottom: 66,
  left: 40,
};

describe("calculateTooltipPosition", () => {
  it("places normal content below when there is no room above", () => {
    expect(
      calculateTooltipPosition({
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
      calculateTooltipPosition({
        anchorRect: anchor,
        tooltipWidth: 900,
        tooltipHeight: 1000,
        viewportWidth: 400,
        viewportHeight: 120,
      }),
    ).toEqual({ top: 8, left: 8, maxHeight: 104 });
  });

  it("prefers above once the MEASURED height fits", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: { ...anchor, top: 200, bottom: 226 },
        tooltipWidth: 200,
        tooltipHeight: 50,
        viewportWidth: 500,
        viewportHeight: 300,
      }),
    ).toEqual({ top: 144, left: 40, maxHeight: 284 });
  });

  it("centers on the anchor and clamps at the viewport edges", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: { top: 200, bottom: 226, left: 40, right: 140 },
        tooltipWidth: 100,
        tooltipHeight: 40,
        viewportWidth: 500,
        viewportHeight: 300,
        align: "center",
      }),
    ).toEqual({ top: 154, left: 40, maxHeight: 284 });
    // The same card near the LEFT edge cannot leave the viewport.
    expect(
      calculateTooltipPosition({
        anchorRect: { top: 200, bottom: 226, left: 4, right: 24 },
        tooltipWidth: 100,
        tooltipHeight: 40,
        viewportWidth: 500,
        viewportHeight: 300,
        align: "center",
      }).left,
    ).toBe(8);
  });

  it("lands on whole pixels — half-pixel layers blur their text", () => {
    // Center 90.5 minus half of 100 is 40.5: the rule must round it.
    expect(
      calculateTooltipPosition({
        anchorRect: { top: 200, bottom: 226, left: 40, right: 141 },
        tooltipWidth: 100,
        tooltipHeight: 41,
        viewportWidth: 500,
        viewportHeight: 300,
        align: "center",
      }),
    ).toEqual({ top: 153, left: 41, maxHeight: 284 });
  });
});
