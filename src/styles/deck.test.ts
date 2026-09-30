import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

const deck = readStyles("deck.css");

describe("the bar's team", () => {
  it("sheds the branch before the name when the window narrows", () => {
    // Identity first, qualifiers last. A chip does not yield (chip.css), so
    // while the branch is in the row the NAME absorbs every missing pixel.
    // The branch is also the copy the deck can spare: every pane header on
    // the stage works on it.
    const narrow = deck.indexOf("@container deck-bar (max-width: 1100px)");
    expect(narrow, "the branch sheds at no width").toBeGreaterThan(-1);
    expect(ruleBody(deck, ".deck__team-branch", narrow).display).toBe("none");

    // The name has no such rung: it is what the bar exists to say.
    expect(ruleBody(deck, ".deck__team-name").display).toBeUndefined();
  });
});

describe("the bar at the window's floor", () => {
  it("never squeezes the controls: the right zone floors at its content, the words take the rest", () => {
    // At 800px with the team list open the bar has ~550px. Equal `1fr`
    // zones would halve that and push buttons off the edge; the right
    // zone's floor is its content, and only the left — words, which
    // ellipsize — may shrink to nothing.
    const [left, centre, right] = ruleBody(deck, ".deck__bar")["grid-template-columns"].split(/\s+(?![^(]*\))/);
    expect(left).toBe("minmax(0, 1fr)");
    expect(centre).toBe("auto");
    expect(right).toBe("minmax(max-content, 1fr)");
    expect(ruleBody(deck, ".deck__bar-left")["min-width"]).toBe("0");
  });
});

describe("the bar's rungs", () => {
  it("answer to the bar's own width, which the team list changes, never the window's", () => {
    // The same window leaves the bar ~200px less with the list open; a rung
    // keyed to the window sheds too late there and too early without it.
    expect(ruleBody(deck, ".deck__bar").container).toBe("deck-bar / inline-size");
    const usage = readStyles("usage.css");
    for (const css of [deck, usage]) {
      expect(css).not.toMatch(/@media[^{]*max-width/);
    }
    expect(usage).toMatch(/@container deck-bar \(max-width: 700px\)\s*\{\s*\.usage-chip \.usage-window__value/);
  });
});

describe("the usage chips", () => {
  it("sit flush: a chip's own padding is the only space between two accounts", () => {
    const usage = readStyles("usage.css");
    expect(ruleBody(usage, ".usage").gap).toBeUndefined();
    expect(ruleBody(usage, ".usage-chip").padding).toBe("0 7px");
  });

  it("centre each agent's mark in its ring, free of any line box", () => {
    // An inline svg sits on the font's baseline and drifts by its descent.
    const usage = readStyles("usage.css");
    expect(ruleBody(usage, ".usage-ring")).toMatchObject({ display: "inline-grid", "place-items": "center" });
    expect(ruleBody(usage, ".usage-ring__glyph")).toMatchObject({
      display: "grid",
      "place-items": "center",
      "line-height": "0",
    });
    expect(ruleBody(usage, ".usage-ring__glyph svg").display).toBe("block");
  });
});

describe("the bar's height", () => {
  it("is the bar alone: the grid adds no strip of canvas under it", () => {
    // A top padding on the grid is canvas continuing the bar, so the bar
    // reads taller than it is and its controls sit high in it.
    expect(ruleBody(deck, ".deck__bar").height).toBe("30px");
    expect(ruleBody(deck, ".deck__grid").padding).toBe("0 6px 6px");
  });
});

describe("the breadcrumb", () => {
  it("draws the workspace's name in one box, link or not, so a team opening moves nothing", () => {
    // The name is a span at the cards and a button inside a team; a button
    // with padding the span lacked shifted every crumb after it.
    const base = ruleBody(deck, ".deck__ws-name");
    expect(base).toMatchObject({
      "box-sizing": "border-box",
      display: "inline-block",
      padding: "2px 4px",
      margin: "0 0 0 -4px",
      border: "0",
      "font-size": "var(--kd-font-normal)",
      "line-height": "18px",
    });
    expect(base.height).toBeUndefined();
    const up = ruleBody(deck, "button.deck__ws-name--up");
    for (const prop of ["padding", "margin", "border", "line-height", "font-size", "height"]) {
      expect(up[prop], prop).toBeUndefined();
    }
  });
});
