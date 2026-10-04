// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { LIST_HEAD_ESTIMATE_PX } from "../presentation/tasks";
import { appCss, readStyles, ruleBody } from "./testSupport";

/** Every class that holds prose a person, an agent or the backend wrote —
 * a refusal or a failed read can carry a path as long as any brief. */
const PROSE = [
  "tasks__card-blocked",
  "tasks__body",
  "tasks__comment-body",
  "tasks__log-text",
  "tasks__error",
  "tasks__placeholder-title",
  "tasks__row-title",
  "tasks__detail-title",
];

function mount(className: string): HTMLElement {
  if (!document.head.querySelector("style")) {
    const source = document.createElement("style");
    source.textContent = appCss;
    document.head.append(source);
  }
  const el = document.createElement("span");
  el.className = className;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("Tasks text never widens its box", () => {
  it.each(PROSE)("%s breaks a long unbroken run instead of overflowing", (className) => {
    // A path or a constant with no spaces spilled a card past its column
    // and gave the task panel a horizontal scroll. break-word, not
    // anywhere: anywhere let a flex item collapse to one letter wide.
    expect(getComputedStyle(mount(className)).overflowWrap).toBe("break-word");
  });

  it("one line, then an ellipsis: .kd-one-line never wraps and may shrink", () => {
    const style = getComputedStyle(mount("kd-one-line"));
    expect(style.whiteSpace).toBe("nowrap");
    expect(style.textOverflow).toBe("ellipsis");
    expect(Number.parseFloat(style.minWidth)).toBe(0);
  });

  it("the task panel's artifact row no longer cuts to one line", () => {
    // It clamps to two lines through .kd-two-lines inside it; a nowrap
    // here would cut it to one again.
    const row = mount("tasks__artifact");
    const link = document.createElement("button");
    link.className = "tasks__link";
    row.append(link);
    expect(getComputedStyle(link).whiteSpace).not.toBe("nowrap");
  });

  it("lays the open task out in two columns by its own width, not by the Expand class", () => {
    // The class flips at once while the width eases; the layout must turn
    // with the width, or a 260px column stands in a 440px card mid-ease.
    const css = readStyles("tasks.css");
    expect(css).toMatch(/\.tasks__detail \{\s*container-type: inline-size;\s*\}/);
    expect(css).toMatch(/@container \(min-width: 720px\)\s*\{\s*\.tasks__detail-body \{[^}]*display: grid/);
    expect(css).not.toMatch(/\.tasks__detail--wide \.tasks__detail-body/);
  });

  it("eases only the person's fold — the rows slide, a fold's rows fade in — resting under reduced motion", () => {
    const css = readStyles("tasks.css");
    // Keyed by data-easing: an agent's move or the anchoring lands still.
    expect(ruleBody(css, ".tasks__list[data-easing] .tasks__list-item").transition).toBe("transform var(--kd-disclosure-motion)");
    expect(ruleBody(css, ".tasks__list[data-easing] .tasks__list-item[data-arriving]").animation).toBe(
      "tasks-row-arrive var(--kd-disclosure-motion)",
    );
    expect(css).not.toMatch(/(^|\n)\.tasks__list-item \{[^}]*transition/);
    const rest = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .tasks__list[data-easing]"));
    expect(rest).toMatch(/\.tasks__list\[data-easing\] \.tasks__list-item \{\s*transition: none;/);
    expect(rest).toMatch(/\.tasks__list\[data-easing\] \.tasks__list-item\[data-arriving\] \{\s*animation: none;/);
  });

  it("a list row's title wraps — the whole title, the row growing with it", () => {
    expect(getComputedStyle(mount("tasks__row-title")).whiteSpace).not.toBe("nowrap");
    const row = readStyles("tasks.css");
    expect(ruleBody(row, ".tasks__row").height).toBeUndefined();
    // What stands beside a wrapped title keeps to its first line.
    expect(ruleBody(row, ".tasks__row")["align-items"]).toBe("flex-start");
    expect(ruleBody(row, ".tasks__row-open")["align-items"]).toBe("flex-start");
  });

  it("a row's age stays on one line", () => {
    expect(getComputedStyle(mount("tasks__row-age")).whiteSpace).toBe("nowrap");
  });

  it("the open task grows to Expand and shrinks to Collapse — between two widths, eased", () => {
    // An auto width (or left: 0) does not transition: the card jumped.
    const card = getComputedStyle(mount("tasks__detail"));
    expect(card.transition).toContain("width");
    expect(getComputedStyle(mount("tasks__detail tasks__detail--wide")).width).toBe("calc(100% - 24px)");
  });

  it("a list heading stands as tall as the list guesses and the pinned one covers", () => {
    // The reveal's padding under the pinned heading is LIST_HEAD_ESTIMATE_PX:
    // a heading of another height would hide a row's top or leave a gap.
    expect(getComputedStyle(mount("tasks__group")).height).toBe(`${LIST_HEAD_ESTIMATE_PX}px`);
  });

  it("a pinned heading ruled out as a drop dims its words, not itself — rows never show through", () => {
    const pinned = mount("tasks__list-pinned");
    const heading = document.createElement("button");
    heading.className = "tasks__group tasks__drop--no";
    const label = document.createElement("span");
    heading.append(label);
    pinned.append(heading);
    expect(getComputedStyle(heading).opacity).toBe("1");
    expect(getComputedStyle(label).opacity).toBe("0.45");
  });

  it("an inline offer is quiet: the quiet ink wins over the inline variant's", () => {
    // The open task's "Attach an artifact" is both; at equal specificity
    // the later rule wins, and the inline one used to be later.
    const button = (classes: string) => {
      const field = mount(classes);
      const el = document.createElement("button");
      el.className = "dropdown__button";
      field.append(el);
      return getComputedStyle(el).color;
    };
    expect(button("dropdown dropdown--inline dropdown--quiet")).toBe(button("dropdown dropdown--quiet"));
    expect(button("dropdown dropdown--inline dropdown--quiet")).not.toBe(button("dropdown dropdown--inline"));
  });

  it("a card may shrink to its column — it never grows to its widest word", () => {
    expect(Number.parseFloat(getComputedStyle(mount("tasks__card")).minWidth)).toBe(0);
  });

  it("a card takes its column's width, not its title's", () => {
    // The card is a <button>, whose auto width is its content's: in the
    // windowed list's block item it grew to its one-line title and the
    // column scrolled sideways.
    const card = document.createElement("button");
    card.className = "tasks__card";
    mount("tasks__column-item").append(card);
    const style = getComputedStyle(card);
    expect(style.width).toBe("100%");
    // 100% of the item is the whole card, padding and border included —
    // a content box would still overhang the column by its padding.
    expect(style.boxSizing).toBe("border-box");
  });
});

describe("a board column's edge", () => {
  it("is reserved at rest, so a drag's dashed edge does not resize it", () => {
    // The drop states colour and dash the edge; they set no width. With no
    // width reserved at rest they would draw the initial 3px and shift the
    // board 6px under the card in flight.
    const css = readStyles("tasks.css");
    expect(ruleBody(css, ".tasks__column").border).toBe("1px solid transparent");
    for (const state of [".tasks__column--drop-ok", ".tasks__column--drop-over"]) {
      const body = ruleBody(css, state);
      expect(body["border-width"], state).toBeUndefined();
      expect(body.border, state).toBeUndefined();
    }
  });
});

describe("the label slot", () => {
  it("drops its \"+ label\" offer once it has the keys", () => {
    const css = readStyles("form.css");
    expect(ruleBody(css, ".combobox--slot .combobox__input:focus::placeholder").color).toBe("transparent");
  });
});
