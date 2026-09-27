// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/** Every class that holds prose a person, an agent or the backend wrote —
 * a refusal or a failed read can carry a path as long as any brief. */
const PROSE = [
  "tasks__card-blocked",
  "tasks__body",
  "tasks__comment-body",
  "tasks__log-text",
  "tasks__error",
  "tasks__placeholder-title",
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
