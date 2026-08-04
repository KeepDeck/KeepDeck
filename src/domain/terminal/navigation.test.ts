import { describe, expect, it } from "vitest";
import { isNavigationKey } from "./navigation";

describe("isNavigationKey", () => {
  it("knows the keys that only move", () => {
    for (const data of [
      "\x1b[A", // arrows, normal cursor mode
      "\x1b[B",
      "\x1b[C",
      "\x1b[D",
      "\x1bOA", // and application cursor mode
      "\x1bOB",
      "\x1bOC",
      "\x1bOD",
      "\x1b[1;5A", // Ctrl+Arrow — the modified form
      "\x1b[1;2B", // Shift+Arrow
      "\x1b[H", // Home / End, both modes
      "\x1b[F",
      "\x1bOH",
      "\x1bOF",
      "\x1b[5~", // PageUp / PageDown, plain and modified
      "\x1b[6~",
      "\x1b[5;5~",
      "\x1bb", // macOS Alt+Left / Alt+Right — xterm rewrites them to these
      "\x1bf",
    ]) {
      expect(isNavigationKey(data), JSON.stringify(data)).toBe(true);
    }
  });

  it("knows the keys that commit", () => {
    // Everything a dialog is actually answered with: codex offers
    // "1. Yes, proceed (y)" / "2. …(p)" / "3. No …(esc)".
    for (const data of ["\r", "\n", "y", "p", "n", "1", "2", "3", "\x1b", " "]) {
      expect(isNavigationKey(data), JSON.stringify(data)).toBe(false);
    }
  });

  it("keeps the editing keys out of navigation", () => {
    // Insert and Delete sit in the same tilde family as the paging keys and
    // both change what is being composed.
    expect(isNavigationKey("\x1b[2~")).toBe(false);
    expect(isNavigationKey("\x1b[3~")).toBe(false);
    // A function key is TWO digits — `\x1b[15~` must not read as `1` + `5~`
    // and get classed with PageUp.
    expect(isNavigationKey("\x1b[15~")).toBe(false);
    expect(isNavigationKey("\x1b[24~")).toBe(false);
  });

  it("matches a whole keystroke, never a fragment of something longer", () => {
    // The caller reports one key at a time, so anything with a sequence
    // merely INSIDE it is not a navigation key. Loose matching here would
    // let a burst that ends in Enter — or a pasted block that happens to
    // contain an arrow — pass as "the user only scrolled".
    expect(isNavigationKey("\x1b[B\r")).toBe(false);
    expect(isNavigationKey("\x1b[B\x1b[B")).toBe(false);
    expect(isNavigationKey("x\x1b[A")).toBe(false);
    expect(isNavigationKey("")).toBe(false);
  });

  it("is not fooled by a terminal reply that resembles one", () => {
    // These never reach a key event — the whole reason the caller reports
    // keystrokes rather than the byte stream — but the anchors mean that
    // even if one did, it would not read as navigation and be silently
    // dropped: cursor position, device attributes, status, window size.
    for (const reply of [
      "\x1b[24;80R",
      "\x1b[?1;2c",
      "\x1b[0n",
      "\x1b[8;24;80t",
    ]) {
      expect(isNavigationKey(reply), JSON.stringify(reply)).toBe(false);
    }
  });
});
