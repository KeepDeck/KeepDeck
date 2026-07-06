import { describe, expect, it } from "vitest";
import { positionHint } from "./hintPosition";

const pane = { width: 800, height: 600 };
const hint = { width: 200, height: 24 };

describe("positionHint", () => {
  it("centers the hint under the anchor when there is room", () => {
    expect(positionHint({ x: 400, y: 100 }, hint, pane)).toEqual({
      left: 300, // 400 - 200/2
      top: 112, // 100 + GAP
    });
  });

  it("clamps to the left edge for an anchor near it", () => {
    expect(positionHint({ x: 10, y: 100 }, hint, pane).left).toBe(8);
  });

  it("clamps to the right edge for an anchor near it", () => {
    // 800 - 200 - MARGIN
    expect(positionHint({ x: 790, y: 100 }, hint, pane).left).toBe(592);
  });

  it("flips above the anchor when the bottom edge would clip it", () => {
    // below would end at 596 + 24 > 600 - MARGIN
    expect(positionHint({ x: 400, y: 584 }, hint, pane).top).toBe(
      584 - 12 - 24,
    );
  });

  it("never places the flipped hint above the pane top", () => {
    const short = { width: 800, height: 30 };
    expect(positionHint({ x: 400, y: 20 }, hint, short).top).toBe(8);
  });

  it("pins to the left margin when the pane is narrower than the hint", () => {
    const narrow = { width: 120, height: 600 };
    expect(positionHint({ x: 60, y: 100 }, hint, narrow).left).toBe(8);
  });
});
