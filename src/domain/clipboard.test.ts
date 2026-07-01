import { describe, it, expect } from "vitest";
import { isCopyChord, normalizeSelection, type CopyKeyEvent } from "./clipboard";

const ev = (over: Partial<CopyKeyEvent> = {}): CopyKeyEvent => ({
  type: "keydown",
  key: "c",
  code: "KeyC",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: true,
  ...over,
});

describe("isCopyChord", () => {
  it("matches Cmd+C on keydown", () => {
    expect(isCopyChord(ev())).toBe(true);
  });

  it("matches the physical C key regardless of layout (Cyrillic 'с')", () => {
    expect(isCopyChord(ev({ key: "с" }))).toBe(true);
  });

  it("leaves Ctrl+C for SIGINT", () => {
    expect(isCopyChord(ev({ metaKey: false, ctrlKey: true }))).toBe(false);
  });

  it("ignores Cmd+Alt+C and Cmd+Ctrl+C", () => {
    expect(isCopyChord(ev({ altKey: true }))).toBe(false);
    expect(isCopyChord(ev({ ctrlKey: true }))).toBe(false);
  });

  it("only fires on keydown, not keyup/keypress", () => {
    expect(isCopyChord(ev({ type: "keyup" }))).toBe(false);
    expect(isCopyChord(ev({ type: "keypress" }))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isCopyChord(ev({ code: "KeyV" }))).toBe(false);
  });
});

describe("normalizeSelection", () => {
  it("strips per-line trailing whitespace, keeping newlines and inner spacing", () => {
    expect(normalizeSelection("abc   \nde f\t\n")).toBe("abc\nde f\n");
  });

  it("leaves clean text untouched", () => {
    expect(normalizeSelection("hello world")).toBe("hello world");
  });

  it("is a no-op on the empty string", () => {
    expect(normalizeSelection("")).toBe("");
  });
});
