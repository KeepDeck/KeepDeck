import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

const strip = readStyles("strip.css");

describe("the strip's doors", () => {
  it("draw «+» and the archive on one unfilled tile, one glyph size", () => {
    // Two doors, not workspaces: one rule each for both, so neither can
    // drift into a size or fill of its own.
    expect(ruleBody(strip, ".strip__mark--add .strip__tile,\n.strip__mark--archive .strip__tile")).toEqual({
      width: "30px",
      height: "30px",
      background: "transparent",
      color: "var(--kd-text-3)",
    });
    expect(ruleBody(strip, ".strip__mark--add svg,\n.strip__mark--archive svg")).toEqual({
      width: "14px",
      height: "14px",
    });
  });
});

describe("what rides a tile's corner", () => {
  it("is ringed in the strip's colour — a mark's dot and the archive's count alike", () => {
    expect(ruleBody(strip, ".strip__tile .strip__dot,\n.strip__badge")["box-shadow"]).toBe("0 0 0 2px var(--kd-strip)");
  });
});
