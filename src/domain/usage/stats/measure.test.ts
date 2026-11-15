import { describe, expect, it } from "vitest";
import { usageEvent } from "../history/event.testSupport";
import { addUsage, amountOf, emptyUsageTally, rowAmount } from "./measure";

const priced = usageEvent({ costUsd: 2, tokens: { input: 10, output: 5, cacheRead: 1_000, cacheWrite: 20 } });
const unpriced = usageEvent({ tokens: { input: 7, cacheRead: 300 } });

describe("a measure", () => {
  it("reads a row as its priced cost, or as its tokens less cache reads", () => {
    expect([rowAmount(priced, "spend"), rowAmount(priced, "tokens")]).toEqual([2, 35]);
    // No price: unknown money, never free — but its tokens are known.
    expect([rowAmount(unpriced, "spend"), rowAmount(unpriced, "tokens")]).toEqual([null, 7]);
  });

  it("adds rows in both measures at once, so a tally reads either way", () => {
    const tally = emptyUsageTally();
    addUsage(tally, priced);
    addUsage(tally, unpriced);
    expect(tally).toMatchObject({ costUsd: 2, pricedEvents: 1, unpricedTokens: 307, tokensLessCacheReads: 42 });
    expect([amountOf(tally, "spend"), amountOf(tally, "tokens")]).toEqual([2, 42]);
  });
});
