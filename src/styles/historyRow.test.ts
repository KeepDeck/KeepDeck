import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

// The data row's layout contract, read from the shipped stylesheet: the
// geometry no DOM can answer in happy-dom (tracks are never resolved
// there), so the SOURCE is the witness. Pinned exactly — the family
// three-column shape, and the metadata line's NON-grid nature — because
// "almost the same template" is how the ragged rows came back the first
// time, and fixed metadata tracks are how the pillared second line came
// back the second.
//
// HONEST LIMIT of this whole file: the stand computes no geometry —
// the row-1 centering below is proven by the ARITHMETIC of the rules
// ((26−18)/2 splits the button overhang both ways instead of letting
// all 8px hang below), and pinned as a CSS contract; the pixel truth
// on screen stays the user's to witness.
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
    // CENTER, not start: title and buttons share row 1's line — start
    // hung the taller buttons below the title (the user's screenshot).
    expect(rule["align-items"]).toBe("center");
  });

  it("the glyph rides row 1 centered with the title; the meta sits in the name's column at its own width", () => {
    const glyph = ruleBody(css, ".history__glyph");
    expect(glyph["grid-row"]).toBe("1");
    expect(glyph["align-self"]).toBe("center");
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

  it("the actions are ONE explicitly placed cell — auto-placement is banned", () => {
    // The defect this pins: two loose buttons took two grid cells, and
    // auto-placement dropped the second onto the meta line. Every cell
    // is explicit now — name (col 2), actions group (col 3, row 1).
    const actions = ruleBody(css, ".history__actions");
    expect(actions["grid-column"]).toBe("3");
    expect(actions["grid-row"]).toBe("1");
    expect(ruleBody(css, ".browser__open")["grid-column"]).toBe("2");
    expect(ruleBody(css, ".browser__open")["grid-row"]).toBe("1");
    // The glyph rides row 1 CENTERED with the title — spanning both
    // rows centered it between the lines (floating); `start` hung the
    // taller buttons below the title line (the user's screenshot).
    const glyph = ruleBody(css, ".history__glyph");
    expect(glyph["grid-row"]).toBe("1");
    expect(glyph["align-self"]).toBe("center");
    // Row 1 centers: title and buttons on ONE line.
    expect(ruleBody(css, ".history__datarow")["align-items"]).toBe("center");
  });

  it("the viewer bar owns symmetric horizontal padding; the push-right rule rides the GROUP", () => {
    const bar = ruleBody(css, ".browser__viewerbar");
    // Symmetric left/right padding ON THE BAR — the old single button
    // carried it; a bar without its own padding lets the last button
    // touch the panel border.
    expect(bar["padding"]).toBe("0 12px");
    // The back button keeps only VERTICAL padding — its old 12px-all
    // would double the bar's left edge.
    expect(ruleBody(css, ".browser__back")["padding"]).toBe("12px 0");
    // The push-right rule applies ONCE, to the actions group — never
    // per button, whose behavior would depend on which rendered.
    const group = ruleBody(css, ".browser__viewerbar .history__actions");
    expect(group["margin-left"]).toBe("auto");
  });
});
