import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

describe("the corner count", () => {
  it("is drawn once: each site that carries one only places it on its glyph", () => {
    // The bell's unread and the strip's archive are one badge in two tones;
    // a site restating its size or colour is the second copy that drifts.
    for (const [file, selector] of [
      ["notifications.css", ".bell__badge"],
      ["strip.css", ".strip__badge"],
    ] as const) {
      const placed = Object.keys(ruleBody(readStyles(file), selector)).sort();
      expect(placed, selector).toEqual(["right", "top"]);
    }
  });

  it("is quiet unless it is told the count wants the person", () => {
    const sheet = readStyles("badges.css");
    expect(ruleBody(sheet, ".kd-count-badge")["background-color"]).toBe("var(--kd-hover)");
    expect(ruleBody(sheet, ".kd-count-badge--alert")["background-color"]).toBe("var(--kd-err)");
  });
});

describe("the YOLO mark", () => {
  it("lets the pointer through its glyph to the mark that carries the label", () => {
    // The bolt fills most of the mark; with the glyph catching the pointer,
    // hovering landed on the SVG and the mark's label rarely showed.
    expect(ruleBody(readStyles("badges.css"), ".yolo-mark svg")["pointer-events"]).toBe("none");
  });
});
