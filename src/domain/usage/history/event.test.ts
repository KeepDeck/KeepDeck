import { describe, expect, it } from "vitest";
import {
  addCost,
  addTokenCounts,
  costOf,
  emptyCostTally,
  tokenTotal,
  usageSessionKey,
} from "./event";
import { usageEvent } from "./event.testSupport";

describe("usage row helpers", () => {
  it("uses a source total when present and otherwise sums the billed classes", () => {
    expect(tokenTotal({ input: 10, output: 2, cacheRead: 4 })).toBe(16);
    expect(tokenTotal({ input: 10, cacheWrite: 3, cacheWrite1h: 5 })).toBe(18);
    // Reasoning is a share of output, never added again.
    expect(tokenTotal({ input: 10, output: 6, reasoning: 4 })).toBe(16);
    expect(tokenTotal({ total: 99, input: 10 })).toBe(99);
  });

  it("adds counts field by field, leaving a field nobody reported absent", () => {
    const into = { input: 1 };
    addTokenCounts(into, { input: 2, cacheRead: 3, cacheWrite1h: 4 });
    expect(into).toEqual({ input: 3, cacheRead: 3, cacheWrite1h: 4 });
  });

  it("costs a priced row, and an unpriced one as nothing known rather than free", () => {
    expect(costOf(usageEvent({ costUsd: 0.5 }))).toBe(0.5);
    expect(costOf(usageEvent({ costBasis: "approximate", costUsd: 0.25 }))).toBe(0.25);
    expect(costOf(usageEvent())).toBeNull();
  });

  it("tallies what priced rows cost and the tokens no price covers", () => {
    const tally = emptyCostTally();
    addCost(tally, usageEvent({ costUsd: 0.1, count: 3 }));
    addCost(tally, usageEvent({ costBasis: "approximate", costUsd: 0.2, count: 2 }));
    addCost(tally, usageEvent({ tokens: { total: 40 }, count: 5 }));
    expect(tally).toEqual({
      costUsd: 0.3,
      pricedEvents: 5,
      approximateEvents: 2,
      unpricedTokens: 40,
    });
  });

  it("keys a session by agent and session id together", () => {
    expect(usageSessionKey({ agent: "claude", sessionId: "s" })).not.toBe(
      usageSessionKey({ agent: "codex", sessionId: "s" }),
    );
  });
});
