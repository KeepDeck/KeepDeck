import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

describe("the inline-rename field", () => {
  it("has one look, and the sites keep only their size and place", () => {
    // Three copies of this field drifted apart (a canvas hole, two radii,
    // one without focus). The look lives on .rename-input alone.
    const look = ruleBody(readStyles("rename.css"), ".rename-input");
    expect(look.border).toBe("1px solid var(--kd-seam-strong)");
    expect(ruleBody(readStyles("rename.css"), ".rename-input:focus")["border-color"]).toBe(
      "var(--kd-focus)",
    );
    const sites: [string, string][] = [
      ["deck.css", ".deck__ws-rename"],
      ["pane.css", ".pane__rename"],
      ["teamCards.css", ".team-card__rename"],
    ];
    for (const [file, selector] of sites) {
      const body = ruleBody(readStyles(file), selector);
      for (const look of [
        "border",
        "border-color",
        "border-radius",
        "background",
        "background-color",
        "color",
        "font",
        "min-width",
        "outline",
      ]) {
        expect(body[look], `${selector} restates ${look}`).toBeUndefined();
      }
      // Nor a state of its own: focus belongs to the one field.
      for (const state of [":focus", ":hover", ":focus-visible"]) {
        expect(readStyles(file).includes(`${selector}${state}`), `${selector}${state}`).toBe(false);
      }
    }
  });
});
