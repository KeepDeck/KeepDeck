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

  it("counts the keys that walk a list of options as moving", () => {
    // Tab and Shift+Tab step between a prompt's options (and cycle claude's
    // permission modes) without choosing anything. They are not navigation
    // in the cursor sense, but they are the same act as the arrows — and
    // reading them as an answer fails in the direction that goes silent.
    expect(isNavigationKey("\t")).toBe(true);
    expect(isNavigationKey("\x1b[Z")).toBe(true);
  });
});
