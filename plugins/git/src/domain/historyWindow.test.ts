import { describe, expect, it } from "vitest";
import type { GitHistory } from "@keepdeck/plugin-api";
import { HISTORY_CHUNK, firstWindow, widenWindow, windowFilled } from "./historyWindow";

const log = (n: number): GitHistory => ({
  forkSha: null,
  ahead: null,
  commits: Array.from({ length: n }, (_, i) => ({
    sha: String(i).padStart(2, "0").repeat(20),
    author: "Me",
    timestamp: 1_760_000_000 - i,
    subject: `commit ${i}`,
  })),
});

describe("history window", () => {
  it("starts at one chunk and grows by one chunk a step", () => {
    expect(firstWindow()).toBe(HISTORY_CHUNK);
    expect(widenWindow(firstWindow())).toBe(2 * HISTORY_CHUNK);
    expect(widenWindow(widenWindow(firstWindow()))).toBe(3 * HISTORY_CHUNK);
  });

  it("a full window may hide more; an underfilled one is the whole log", () => {
    expect(windowFilled(log(HISTORY_CHUNK), HISTORY_CHUNK)).toBe(true);
    expect(windowFilled(log(HISTORY_CHUNK - 1), HISTORY_CHUNK)).toBe(false);
    expect(windowFilled(log(0), HISTORY_CHUNK)).toBe(false);
  });

  it("nothing read yet means nothing more to ask for", () => {
    expect(windowFilled(null, HISTORY_CHUNK)).toBe(false);
  });
});
