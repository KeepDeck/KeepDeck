import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

// The data row's layout contract, read from the shipped stylesheet: the
// geometry no DOM can answer in happy-dom (tracks are never resolved
// there), so the SOURCE is the witness. Pinned exactly — the family
// three-column shape, and the metadata line's NON-grid nature — because
// "almost the same template" is how the ragged rows came back the first
// time, and fixed metadata tracks are how the pillared second line came
// back the second.
describe("history data row layout contract", () => {
  const css = readStyles("history.css");

  it("the data row is the family three-column grid (bell__item's shape)", () => {
    const rule = ruleBody(css, ".history__datarow");
    expect(rule["display"]).toBe("grid");
    const template = rule["grid-template-columns"].replace(/\s+/g, " ").trim();
    // Explicit and shared by every row: glyph column, the name takes
    // the rest, actions of their own width. No per-row content sizing.
    expect(template).toBe("16px minmax(0, 1fr) auto");
    expect(rule["column-gap"]).toBe("10px");
    expect(rule["row-gap"]).toBe("4px");
    expect(rule["align-items"]).toBe("start");
  });

  it("the glyph spans both rows; the meta sits in the name's column at its own width", () => {
    const glyph = ruleBody(css, ".history__glyph");
    expect(glyph["grid-row"]).toBe("1 / -1");
    const meta = ruleBody(css, ".history__meta");
    expect(meta["grid-column"]).toBe("2");
    expect(meta["justify-self"]).toBe("start");
  });

  it("the meta line is a TEXT FLOW, never a grid with fixed tracks", () => {
    const meta = ruleBody(css, ".history__meta");
    // The exact opposite of a track contract: display flex with wrap —
    // crowded meta wraps WHOLE to the next line, it never clips and
    // never leaves pillars with a hole on the right.
    expect(meta["display"]).toBe("flex");
    expect(meta["flex-wrap"]).toBe("wrap");
    expect(meta["grid-template-columns"]).toBeUndefined();
  });

  it("the meta's separators are GENERATED — every part but the first", () => {
    // NOTE: generated content never reaches the DOM in this stand
    // (happy-dom resolves no ::before into the tree), so the WITNESS is
    // the rule's own text — do not look for the middot in a DOM test.
    // (ruleBody cannot parse the combinator selector; a direct source
    // match is the witness.) The «* + *» shape is the load-bearing
    // half: the separator rides BETWEEN rendered parts only, so an
    // absent part is an absent separator — no hanging dot at either
    // end, no dot beside a lone part, under any set of facts, BY
    // CONSTRUCTION.
    const rule = css.match(
      /\.history__meta\s*>\s*\*\s*\+\s*\*\s*::before\s*\{([^{}]*)\}/,
    );
    if (!rule) {
      throw new Error(
        "no generated-separator rule for the meta line (.history__meta > * + *::before)",
      );
    }
    const decls = rule[1];
    expect(decls).toContain('content: "·"');
  });
});
