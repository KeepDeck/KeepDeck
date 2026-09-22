// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/**
 * WebKit's own stylesheet — the one the app runs under — gives every
 * <button> `align-items: flex-start`. happy-dom has no such default, and
 * neither has Chromium, so the fixture states it: a user-agent sheet comes
 * before every author sheet, which is exactly where it is placed here.
 * Without it this file would pass with base.css's rule deleted.
 */
const WEBKIT_BUTTON_DEFAULT = "button { align-items: flex-start; }";

function mount(markup: string): HTMLElement {
  for (const css of [WEBKIT_BUTTON_DEFAULT, appCss]) {
    const sheet = document.createElement("style");
    sheet.textContent = css;
    document.head.append(sheet);
  }
  document.body.innerHTML = markup;
  return document.body.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("button alignment under WebKit's default", () => {
  it("lets a column button's children span it, so their ellipsis can fire", () => {
    // Under flex-start each child is as wide as its text: a long title ran
    // out of the artifacts row and under its History and ×.
    const row = mount("<button class='artifacts__row-open'></button>");
    expect(getComputedStyle(row).alignItems).toBe("normal");
  });

  it("leaves a button that names its own alignment alone", () => {
    // An element rule must lose to a class, or the reset would flatten
    // every row that centres its icon against its label.
    const row = mount("<button class='rail__select'></button>");
    expect(getComputedStyle(row).alignItems).toBe("center");
  });
});
