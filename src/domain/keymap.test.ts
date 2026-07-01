import { describe, expect, it } from "vitest";
import { keyAction, type KeyEventLike } from "./keymap";

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe("keyAction", () => {
  it("sends the CSI-u sequence on Shift+Enter keydown and blocks", () => {
    expect(keyAction(ev({ shiftKey: true }))).toEqual({
      send: "\x1b[13;2u",
      block: true,
    });
  });

  it("blocks Shift+Enter keypress/keyup too, but sends nothing", () => {
    // Blocking only keydown lets the keypress/keyup slip through and submit.
    expect(keyAction(ev({ shiftKey: true, type: "keypress" }))).toEqual({
      send: null,
      block: true,
    });
    expect(keyAction(ev({ shiftKey: true, type: "keyup" }))).toEqual({
      send: null,
      block: true,
    });
  });

  it("leaves plain Enter to xterm (submit)", () => {
    expect(keyAction(ev({}))).toEqual({ send: null, block: false });
  });

  it("ignores Shift+Enter combined with another modifier", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
      expect(keyAction(ev({ shiftKey: true, [mod]: true }))).toEqual({
        send: null,
        block: false,
      });
    }
  });

  it("ignores Shift with a non-Enter key", () => {
    expect(keyAction(ev({ key: "a", shiftKey: true }))).toEqual({
      send: null,
      block: false,
    });
  });
});
