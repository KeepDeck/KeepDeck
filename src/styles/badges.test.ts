import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

describe("the YOLO mark", () => {
  it("lets the pointer through its glyph to the mark that carries the label", () => {
    // The bolt fills most of the mark; with the glyph catching the pointer,
    // hovering landed on the SVG and the mark's label rarely showed.
    expect(ruleBody(readStyles("badges.css"), ".yolo-mark svg")["pointer-events"]).toBe("none");
  });
});
