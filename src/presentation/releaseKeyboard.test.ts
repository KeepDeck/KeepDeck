// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { releaseKeyboard } from "./releaseKeyboard";

afterEach(() => {
  document.body.innerHTML = "";
});

function input(): HTMLInputElement {
  const node = document.createElement("input");
  document.body.appendChild(node);
  return node;
}

describe("releaseKeyboard", () => {
  it("gives the keyboard back when the element is holding it", () => {
    const mine = input();
    mine.focus();

    releaseKeyboard(mine);

    expect(document.activeElement).not.toBe(mine);
  });

  it("leaves the keyboard alone when someone else has it", () => {
    const mine = input();
    const theirs = input();
    theirs.focus();

    releaseKeyboard(mine);

    // The case this exists for: by the time a pane is told it may no longer
    // hold the keyboard, the dialog that caused the edge — or the pane
    // selected in the same commit — may already have taken it. Blurring then
    // takes it from the surface the user is looking at.
    expect(document.activeElement).toBe(theirs);
  });

  it("does nothing when there is no element to release", () => {
    const theirs = input();
    theirs.focus();

    expect(() => releaseKeyboard(null)).not.toThrow();
    expect(() => releaseKeyboard(undefined)).not.toThrow();

    expect(document.activeElement).toBe(theirs);
  });
});
