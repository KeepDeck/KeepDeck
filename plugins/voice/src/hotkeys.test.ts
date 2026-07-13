import { describe, expect, it } from "vitest";
import { endsHold, pttMode, type KeyLike } from "./hotkeys";

const key = (over: Partial<KeyLike>): KeyLike => ({
  code: "Space",
  key: " ",
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  ...over,
});

describe("pttMode", () => {
  it("⌥Space is command, ⌥⇧Space is dictation", () => {
    expect(pttMode(key({ altKey: true }))).toBe("command");
    expect(pttMode(key({ altKey: true, shiftKey: true }))).toBe("dictation");
  });

  it("anything else is not a PTT chord", () => {
    expect(pttMode(key({}))).toBeNull(); // plain space types a space
    expect(pttMode(key({ altKey: true, ctrlKey: true }))).toBeNull();
    expect(pttMode(key({ altKey: true, metaKey: true }))).toBeNull();
    expect(pttMode(key({ altKey: true, code: "KeyV" }))).toBeNull();
  });
});

describe("endsHold", () => {
  it("releasing space or either modifier ends the hold", () => {
    expect(endsHold(key({}))).toBe(true);
    expect(endsHold(key({ code: "AltLeft", key: "Alt" }))).toBe(true);
    expect(endsHold(key({ code: "ShiftLeft", key: "Shift" }))).toBe(true);
    expect(endsHold(key({ code: "KeyA", key: "a" }))).toBe(false);
  });
});
