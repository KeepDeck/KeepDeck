import { describe, expect, it } from "vitest";
import { tipPosition } from "./tipPlacement";

const anchor = {
  top: 40,
  right: 140,
  bottom: 66,
  left: 40,
};

describe("tipPosition", () => {
  it("places normal content below when there is no room above", () => {
    expect(
      tipPosition({
        anchorRect: anchor,
        tipWidth: 200,
        tipHeight: 50,
        viewportWidth: 500,
        viewportHeight: 300,
      }),
    ).toEqual({ top: 72, left: 40, maxHeight: 284 });
  });

  it("prefers above once the MEASURED height fits", () => {
    expect(
      tipPosition({
        anchorRect: { ...anchor, top: 200, bottom: 226 },
        tipWidth: 200,
        tipHeight: 50,
        viewportWidth: 500,
        viewportHeight: 300,
      }),
    ).toEqual({ top: 144, left: 40, maxHeight: 284 });
  });

  it("caps pathological content and keeps the whole layer inside the viewport", () => {
    expect(
      tipPosition({
        anchorRect: anchor,
        tipWidth: 900,
        tipHeight: 1000,
        viewportWidth: 400,
        viewportHeight: 120,
      }),
    ).toEqual({ top: 8, left: 8, maxHeight: 104 });
  });

  it("centers on the anchor and clamps at the viewport edges", () => {
    expect(
      tipPosition({
        anchorRect: { ...anchor, top: 200, bottom: 226 },
        tipWidth: 100,
        tipHeight: 40,
        viewportWidth: 500,
        viewportHeight: 300,
        align: "center",
      }),
    ).toEqual({ top: 154, left: 40, maxHeight: 284 });
    // The same card near the LEFT edge cannot leave the viewport.
    expect(
      tipPosition({
        anchorRect: { top: 200, bottom: 226, left: 4, right: 24 },
        tipWidth: 100,
        tipHeight: 40,
        viewportWidth: 500,
        viewportHeight: 300,
        align: "center",
      }).left,
    ).toBe(8);
  });

  it("lands on whole pixels — half-pixel cards blur their text", () => {
    // Center 90.5 minus half of 100 is 40.5: the rule must round it.
    expect(
      tipPosition({
        anchorRect: { top: 200, bottom: 226, left: 40, right: 141 },
        tipWidth: 100,
        tipHeight: 41,
        viewportWidth: 500,
        viewportHeight: 300,
        align: "center",
      }),
    ).toEqual({ top: 153, left: 41, maxHeight: 284 });
  });
});
