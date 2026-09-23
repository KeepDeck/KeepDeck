// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/** Every class that holds text a person, an agent or the backend wrote —
 * a refusal or a failed read can carry a path as long as any brief. */
const WRITTEN_TEXT = [
  "tasks__card-title",
  "tasks__card-blocked",
  "tasks__detail-title",
  "tasks__body",
  "tasks__comment-body",
  "tasks__log-text",
  "tasks__link",
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
  it.each(WRITTEN_TEXT)("%s breaks a long unbroken run instead of overflowing", (className) => {
    // A path or a constant with no spaces spilled a card past its column
    // and gave the task panel a horizontal scroll.
    expect(getComputedStyle(mount(className)).overflowWrap).toBe("anywhere");
  });

  it("a card may shrink to its column — it never grows to its widest word", () => {
    expect(Number.parseFloat(getComputedStyle(mount("tasks__card")).minWidth)).toBe(0);
  });
});
