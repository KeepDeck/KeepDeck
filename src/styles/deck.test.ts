import { describe, expect, it } from "vitest";
import { px, readStyles, ruleBody } from "./testSupport";
import { STRIP_MOTION_MS } from "../app/stripTeamsMotion";

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
    const ring = readStyles("progressRing.css");
    expect(ruleBody(ring, ".progress-ring")).toMatchObject({ display: "inline-grid", "place-items": "center" });
    expect(ruleBody(ring, ".progress-ring__mark")).toMatchObject({
      display: "grid",
      "place-items": "center",
      "line-height": "0",
    });
    expect(ruleBody(ring, ".progress-ring__mark svg").display).toBe("block");
  });

  it("centre on whole pixels: the mark fills its box, and ring minus box is even", () => {
    // A half-pixel offset rounds one way or the other per mark — the eye
    // reads that as a mark sitting off-centre.
    const ring = readStyles("progressRing.css");
    const size = (sel: string, prop: string) => px(ruleBody(ring, sel)[prop]);
    for (const prop of ["width", "height"]) {
      const outer = size(".progress-ring", prop);
      const box = size(".progress-ring__mark", prop);
      expect(size(".progress-ring__mark svg", prop), prop).toBe(box);
      expect((outer - box) % 2, prop).toBe(0);
      expect(Number.isInteger(outer) && Number.isInteger(box), prop).toBe(true);
    }
  });

  it("move a ring to a new reading instead of jumping to it", () => {
    // A custom property animates only once registered with a type; it
    // inherits so the painted track follows the value the ring transitions.
    const ring = readStyles("progressRing.css");
    expect(ring).toMatch(/@property --progress-ring-fill\s*\{[^}]*syntax:\s*"<number>"[^}]*inherits:\s*true/);
    expect(ruleBody(ring, ".progress-ring").transition).toMatch(/^--progress-ring-fill \d+ms ease-out$/);
    expect(ring).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.progress-ring\s*\{\s*transition: none/);
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

describe("the workspace strip's open column", () => {
  const strip = readStyles("strip.css");

  it("keeps one numeric layer open and shut, so closing animates", () => {
    // A layer that changes on close drops the narrowing column under the
    // stage — and `auto` ↔ a number is not interpolated, so no transition
    // delay can save it. The layer is set once, on the column itself.
    const col = ruleBody(strip, ".strip__col");
    expect(col["z-index"]).toMatch(/^\d+$/);
    expect(ruleBody(strip, ".strip--revealed .strip__col")["z-index"]).toBeUndefined();
    expect(col.transition).toMatch(/\bwidth\b/);
  });

  it("uncovers the names with its edge, not with a fade of their own", () => {
    // A per-name fade runs on each name's own clock, and a mark that was
    // just dragged starts it late: its name pops in behind the others.
    expect(ruleBody(strip, ".strip__col").overflow).toBe("hidden");
    const name = ruleBody(strip, ".strip__name");
    expect(name.opacity).toBeUndefined();
    expect(name.transition).toBeUndefined();
  });

  it("rings a keyboard-focused mark with the house focus ring, inside the clip", () => {
    const focus = ruleBody(strip, ".strip__mark:focus-visible");
    expect(focus.outline).toBe("1px solid var(--kd-focus)");
    // Inset: the column clips (overflow hidden), so an outset ring is cut.
    expect(focus["outline-offset"]).toBe("-1px");
  });

  it("widens on the clock its team lists move on, so the edge and a list arrive together", () => {
    const transition = ruleBody(strip, ".strip__col").transition;
    // Same duration AND the same curve: the lists move on 1 − (1 − x)³.
    expect(transition).toMatch(new RegExp(`width ${STRIP_MOTION_MS}ms cubic-bezier\\(0\\.33, 1, 0\\.68, 1\\)`));
  });

  it("leaves a workspace's group unpositioned, so the reorder measures through the list", () => {
    // collectMarkRects reads each group's offsetTop, which counts from its
    // offsetParent. A positioned group would silently become that parent
    // for its children — and a positioned wrapper ANYWHERE between the list
    // and the group would move the reorder's whole frame.
    expect(ruleBody(strip, ".strip__group").position).toBeUndefined();
    expect(ruleBody(strip, ".strip__marks").position).toBe("relative");
  });

  it("hides every name wholly behind the shut edge", () => {
    // The name starts at the mark's inset plus its own offset; any of it
    // inside the shut column shows as a sliver beside every mark.
    const col = ruleBody(strip, ".strip__col");
    const inset = px(col.padding.split(/\s+/)[3]);
    const nameStart = inset + px(ruleBody(strip, ".strip__name").left);
    expect(nameStart).toBeGreaterThanOrEqual(px(col.width));
  });
});
