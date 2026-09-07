// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarIcon } from "../components/AppIcons";
import { px, readStyles, ruleBody } from "./testSupport";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The bar's seam, checked as ARITHMETIC.
 *
 * `.deck__team-bar--seamed` exists to put the team group's left border in the
 * same column as the rail's right border, so the line parting the rail from
 * the stage carries on up through the bar. Whether it lands there is a
 * question about a rendered page, and happy-dom renders none — it lays
 * nothing out, so no assertion here can look at the seam.
 *
 * What it CAN look at is every term the margin was derived from, because none
 * of them is a layout result: they are declarations in four files plus one
 * width written on an icon. So the test restates the derivation and fails when
 * any single term moves — which is the whole risk this margin introduced. The
 * deck had never referred to the rail's width before; now it does, from
 * another stylesheet, with nothing but a comment tying them together.
 *
 * What it does NOT catch, said out loud: this proves the ARITHMETIC, not the
 * pixels. A third rule reaching the toggle's box — a margin on a future
 * tooltip anchor, say — would move the seam on screen and leave this green.
 */
describe("the bar's seam sits in the rail's own border column", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const deck = readStyles("deck.css");
  const rail = readStyles("rail.css");
  const button = readStyles("button.css");

  it("adds up to the rail's width, term by term", () => {
    // The rail is content-box (nothing in this app sets box-sizing globally),
    // so its border-right paints the column that STARTS at its width — which
    // is why the sum below targets 200 and not 201.
    const railWidth = px(ruleBody(rail, ".rail").width);

    // Where the bar's content starts.
    const barPadding = px(ruleBody(deck, ".deck__bar").padding);
    // The gap this zone puts BETWEEN its groups (the tighter gap inside a
    // group is a different rule, and not part of this run).
    const zoneGap = px(ruleBody(deck, ".deck__bar-left").gap);

    // The rail toggle, the one thing standing left of the seam: a ghost
    // button's padding either side of the icon it holds. The icon's size is
    // written on the element, not in CSS, so it is read from the shipped
    // component rather than repeated here as a number.
    const ghostPadding = px(ruleBody(button, ".kd-btn--ghost").padding);
    act(() => root.render(createElement(SidebarIcon)));
    const iconWidth = Number(host.querySelector("svg")?.getAttribute("width"));
    expect(iconWidth, "the toggle icon has no width of its own").toBeGreaterThan(0);
    const toggleWidth = ghostPadding * 2 + iconWidth;

    const seam = px(ruleBody(deck, ".deck__team-bar--seamed")["margin-left"]);

    expect(
      barPadding + toggleWidth + zoneGap + seam,
      `the seam missed the rail's border column: ${barPadding} + ${toggleWidth} + ${zoneGap} + ${seam} should be ${railWidth}`,
    ).toBe(railWidth);
  });

  it("draws the seam in the rail's own colour, so one line reads as one line", () => {
    // Geometry alone would leave two segments of different colours pretending
    // to be a single vertical. The bar's group seam and the rail's edge are
    // the same declaration in two files; that is what makes the line continue
    // rather than merely resume.
    const groupSeam = ruleBody(deck, ".bar__group + .bar__group")["border-left"];
    const railEdge = ruleBody(rail, ".rail")["border-right"];
    expect(groupSeam).toBe(railEdge);
  });

  it("sheds the branch before the name when the window narrows", () => {
    // Identity first, qualifiers last. A chip does not yield (chip.css), so
    // while the branch is in the row the NAME absorbs every missing pixel —
    // and past the seam the name has 157px less to give. The branch is also
    // the copy the deck can spare: every pane header on the stage wears it.
    const narrow = deck.indexOf("@media (max-width: 1100px)");
    expect(narrow, "the branch sheds at no width").toBeGreaterThan(-1);
    expect(ruleBody(deck, ".deck__team-branch", narrow).display).toBe("none");

    // The name has no such rung: it is what the strip exists to say.
    expect(ruleBody(deck, ".deck__team-name").display).toBeUndefined();
  });
});
