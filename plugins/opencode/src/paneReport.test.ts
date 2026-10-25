import { describe, expect, it } from "vitest";
import { boundReport, createWindowCache, tokenCounts, usageReport } from "../resources/keepdeck-plugin/pane-report.js";

describe("what a pane's report says, on either opencode", () => {
  it("reads opencode's token usage as five counts", () => {
    expect(tokenCounts({ input: 3, output: 2, reasoning: 1, cache: { read: 5, write: 4 } })).toEqual({
      input: 3,
      output: 2,
      reasoning: 1,
      cacheRead: 5,
      cacheWrite: 4,
    });
    expect(tokenCounts(undefined)).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("binds a first conversation as a start and a later one as continuing", () => {
    expect(boundReport("ses_a", false)).toEqual({ sessionId: "ses_a", source: "startup" });
    expect(boundReport("ses_b", true)).toEqual({ sessionId: "ses_b", source: "new" });
    // A session the user opened in the TUI (follower.js).
    expect(boundReport("ses_c", true, true)).toEqual({ sessionId: "ses_c", source: "resume" });
    // The pane's first conversation is a startup however it was reached.
    expect(boundReport("ses_d", false, true)).toEqual({ sessionId: "ses_d", source: "startup" });
  });

  it("counts the context in use from the last turn, and leaves out what is unknown", () => {
    const turn = { input: 100, output: 10, reasoning: 0, cacheRead: 5, cacheWrite: 0, cost: 9 };
    expect(
      usageReport({ sessionId: "ses_a", sequence: 1, lastTurn: turn, totals: turn, costUsd: 9 }),
    ).toEqual({
      sessionId: "ses_a",
      sequence: 1,
      contextTokens: 115,
      totals: { input: 100, output: 10, reasoning: 0, cacheRead: 5, cacheWrite: 0 },
      lastTurn: { input: 100, output: 10, reasoning: 0, cacheRead: 5, cacheWrite: 0 },
      costUsd: 9,
    });
  });
});

describe("context windows by model", () => {
  it("keys a window by provider and model, since model ids repeat across providers", async () => {
    const windowOf = createWindowCache(async () => [
      { providerID: "a", modelID: "m", window: 100 },
      { providerID: "b", modelID: "m", window: 200 },
    ]);
    expect(await windowOf("b", "m")).toBe(200);
    expect(await windowOf("a", "m")).toBe(100);
    expect(await windowOf("c", "m")).toBeUndefined();
  });

  it("reads the catalog once, and again only after a failed read", async () => {
    let reads = 0;
    const windowOf = createWindowCache(async () => {
      reads += 1;
      if (reads === 1) throw new Error("offline");
      return [{ providerID: "a", modelID: "m", window: 100 }];
    });
    expect(await windowOf("a", "m")).toBeUndefined();
    expect(await windowOf("a", "m")).toBe(100);
    expect(await windowOf("a", "m")).toBe(100);
    expect(reads).toBe(2);
  });
});
