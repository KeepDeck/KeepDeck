import { describe, expect, it } from "vitest";
import { answersWait } from "./answers";

describe("answersWait", () => {
  it("treats the keys that actually answer a dialog as an answer", () => {
    // codex offers "1. Yes, proceed (y)" / "2. …(p)" / "3. No …(esc)", and
    // claude's prompt is the same shape — every one of these commits.
    for (const data of ["\r", "\n", "y", "p", "n", "1", "2", "3", "\x1b"]) {
      expect(answersWait(data), JSON.stringify(data)).toBe(true);
    }
  });

  it("does not let a user reading the question answer it", () => {
    for (const data of [
      "\x1b[A", // arrows, both encodings
      "\x1b[B",
      "\x1bOC",
      "\x1bOD",
      "\x1b[1;5A", // Ctrl+Arrow — the modified form
      "\x1b[5~", // PageUp / PageDown
      "\x1b[6~",
      "\x1b[H", // Home / End, both spellings
      "\x1b[F",
      "\x1b[1~",
      "\x1b[4~",
      "\x1b[<0;12;34M", // SGR mouse press and release
      "\x1b[<0;12;34m",
      "\x1b[I", // focus tracking — the terminal, not the user
      "\x1b[O",
    ]) {
      expect(answersWait(data), JSON.stringify(data)).toBe(false);
    }
  });

  it("reads the X10 mouse report's three trailing bytes as part of it", () => {
    // `\x1b[M` is followed by exactly three bytes that may be ANY byte —
    // including ones that would otherwise read as typed characters.
    expect(answersWait("\x1b[M\x20\x21\x22")).toBe(false);
    // Its payload can be a printable that must not leak through as an answer.
    expect(answersWait("\x1b[MABC")).toBe(false);
    // Truncated (a split read) is not a valid report — it stays an answer
    // rather than being silently swallowed.
    expect(answersWait("\x1b[MA")).toBe(true);
  });

  it("keeps editing keys as answers — they are not navigation", () => {
    // Insert (`2~`) and Delete (`3~`) sit between the paging keys in the same
    // tilde family, and both change the answer being composed.
    expect(answersWait("\x1b[2~")).toBe(true);
    expect(answersWait("\x1b[3~")).toBe(true);
    // A function key is `\x1b[15~` — two digits, so it must not be read as
    // `1` + `5~` and silently classed with PageUp.
    expect(answersWait("\x1b[15~")).toBe(true);
  });

  it("answers when a burst ends in a commit", () => {
    // Picking the second option: two arrows to move, then Enter. The arrows
    // decide nothing; the Enter does, and xterm can deliver them as one chunk.
    expect(answersWait("\x1b[B\x1b[B\r")).toBe(true);
  });

  it("counts a paste as an answer, markers and all", () => {
    // Bracketed paste wraps real text; the text is what reaches the agent.
    expect(answersWait("\x1b[200~yes\x1b[201~")).toBe(true);
  });

  it("is not answered by nothing at all", () => {
    expect(answersWait("")).toBe(false);
  });
});
