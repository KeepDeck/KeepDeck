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
    // The hue moves with the fill: painted as `color` (currentColor in the
    // track), which animates in every engine, eased the same way.
    expect(ruleBody(ring, ".progress-ring").color).toBe("var(--progress-ring-hue)");
    expect(ruleBody(ring, ".progress-ring").transition).toMatch(/^--progress-ring-fill \d+ms ease-out,\s*color \d+ms ease-out$/);
    expect(ring).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.progress-ring\s*\{\s*transition: none/);
  });
});

describe("the status ring", () => {
  it("is the pie: the sector filled solid in an outline, no band mask", () => {
    const ring = readStyles("progressRing.css");
    // The outline: a whole pixel in the hue.
    const outline = ruleBody(ring, ".progress-ring--pie::before");
    expect(outline.border).toBe("1px solid currentColor");
    expect(outline.mask).toBe("none");
    // The sector: the hue as a plain background, cut to the fill by an
    // alpha mask — never currentColor inside a gradient (WebKit repaints
    // that only when a colour transition ends).
    const sector = ruleBody(ring, ".progress-ring--pie::after");
    expect(sector.mask).toBe("conic-gradient(#000 calc(var(--progress-ring-fill) * 1%), transparent 0)");
    expect(ring).toMatch(/\.progress-ring::after \{\s*background-color: currentColor;/);
    expect(ring).not.toMatch(/gradient\([^;]*currentColor/);
  });

  it("eases to a new rung — fill and hue — and rests under reduced motion", () => {
    const status = readStyles("status.css");
    expect(ruleBody(status, ".progress-ring.status-ring").transition).toMatch(
      /^--progress-ring-fill \d+ms ease-out,\s*color \d+ms ease-out$/,
    );
    expect(ruleBody(status, ".status-ring--barred .status-ring__bar").opacity).toBe("1");
    // Each hue outranks the base's grey: the tones match at its specificity.
    for (const tone of ["working", "waiting", "failed", "done"]) {
      expect(ruleBody(status, `.progress-ring.status-ring--${tone}`)["--progress-ring-hue"]).toBe(`var(--status-${tone})`);
    }
    expect(status).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.progress-ring\.status-ring,\s*\.status-ring__bar\s*\{\s*transition: none/);
  });
});

describe("the chosen plate and the drag's ghost", () => {
  it("a chosen toggle or choice changes its fill, never its edge — so it stands the size of its neighbour", () => {
    const button = readStyles("button.css");
    // The rule that names the checked option (with the pressed toggle).
    const block = /\.kd-btn--secondary\[aria-checked="true"\][^{]*\{([^}]*)\}/.exec(button)![1];
    expect(block).toMatch(/background-color: var\(--kd-text\);/);
    expect(block).not.toMatch(/border/);
  });

  it("only the card's ghost casts a filter shadow; the list's row ghost wears the float shell", () => {
    const tasks = readStyles("tasks.css");
    expect(ruleBody(tasks, ".tasks__ghost").filter).toBeUndefined();
    expect(ruleBody(tasks, ".tasks__ghost--card").filter).toMatch(/^drop-shadow/);
    expect(readStyles("float.css")).toMatch(/\.tasks__row--ghost,/);
    // As tall as the row it left, the shell's outer ring counted.
    expect(ruleBody(tasks, ".tasks__row").height).toBe("34px");
    expect(ruleBody(tasks, ".tasks__row--ghost").height).toBe("32px");
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

  it("uncovers names by its edge on open, and fades them as a close begins", () => {
    // Open: the edge alone — no fade-in, which runs on each element's own
    // clock and let a just-dragged mark's name lag behind the rest.
    expect(ruleBody(strip, ".strip__col").overflow).toBe("hidden");
    const name = ruleBody(strip, ".strip__name");
    expect(name.opacity).toBeUndefined();
    expect(name.transition).toBeUndefined();
    const shown = ruleBody(strip, ".strip--revealed .strip__teams");
    expect(shown.opacity).toBe("1");
    expect(shown.transition).toBeUndefined();
    // Close: faded out well inside the close, not cut late by the edge.
    const hidden = ruleBody(strip, ".strip:not(.strip--revealed) .strip__teams");
    expect(hidden.opacity).toBe("0");
    const fade = Number(/opacity (\d+)ms/.exec(hidden.transition ?? "")?.[1]);
    expect(fade).toBeGreaterThan(0);
    expect(fade).toBeLessThan(STRIP_MOTION_MS);
  });

  it("rings a keyboard-focused mark with the house focus ring, inside the clip", () => {
    const focus = ruleBody(strip, ".strip__mark:focus-visible");
    expect(focus.outline).toBe("1px solid var(--kd-focus)");
    // Inset: the column clips (overflow hidden), so an outset ring is cut.
    expect(focus["outline-offset"]).toBe("-1px");
  });

  it("runs every strip motion on the one clock and curve", () => {
    // The column's shadow and the chevron's turn too — a literal left
    // behind drifts the moment the clock changes.
    const curve = `${STRIP_MOTION_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`;
    expect(ruleBody(strip, ".strip__col").transition).toContain(`box-shadow ${curve}`);
    // The chevron is the house's (base.css .kd-chevron), on this clock too.
    expect(ruleBody(readStyles("base.css"), ".kd-chevron").transition).toBe(`transform ${curve}`);
  });

  it("widens on the clock its team lists move on, so the edge and a list arrive together", () => {
    const transition = ruleBody(strip, ".strip__col").transition;
    // Same duration AND the same curve: the lists move on 1 − (1 − x)³.
    expect(transition).toMatch(new RegExp(`width ${STRIP_MOTION_MS}ms cubic-bezier\\(0\\.33, 1, 0\\.68, 1\\)`));
  });

  it("cuts a team list's rows at the height its motion drives, its room inside", () => {
    // The motion sets the list's height; rows past it must be clipped, not
    // painted over the marks below, and no margin may sit outside the box.
    const teams = ruleBody(strip, ".strip__teams");
    expect(teams.overflow).toBe("hidden");
    // No padding or margin on the driven box: its own padding would hold a
    // "0" height at 4px (a twitch on every mount and fold end), and a
    // margin sits outside the motion. The room is the last row's, inside.
    expect(teams.padding).toBe("0");
    expect(teams.margin).toBe("0");
    expect(ruleBody(strip, ".strip__teams > li:last-child")["padding-bottom"]).toBe("4px");
  });

  it("rests the chevron's turn under reduced motion, with the strip's other motion", () => {
    expect(readStyles("base.css")).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.kd-chevron[^}]*transition: none/);
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
