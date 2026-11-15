import { describe, expect, it } from "vitest";
import { costCoverage, displayCost } from "./statsCost";

describe("costCoverage", () => {
  const SOURCE =
    "Costs are estimated from each model maker's list price at the time of the call (models.dev), not subscription charges.";
  const tally = (over: Partial<Parameters<typeof costCoverage>[0]>) => ({
    costUsd: 1,
    pricedEvents: 4,
    approximateEvents: 0,
    unpricedTokens: 0,
    totalTokens: 1_000,
    ...over,
  });

  it("names a fully priced period as estimates from list prices, never as charges", () => {
    expect(costCoverage(tally({}))).toBe(SOURCE);
  });

  it("says when some prices were stand-ins", () => {
    expect(costCoverage(tally({ approximateEvents: 1 }))).toBe(
      `${SOURCE} Some are approximate, priced by the nearest known rate.`,
    );
  });

  it("says how much of the usage no price covers", () => {
    expect(costCoverage(tally({ unpricedTokens: 250 }))).toBe(
      `${SOURCE} 25% of tokens ran on models without a known price and are not counted; a sum marked “+” leaves them out.`,
    );
    // A sliver is never rounded away to "0%".
    expect(costCoverage(tally({ unpricedTokens: 1 }))).toContain("<1% of tokens");
  });

  it("keeps the tokens on offer when nothing in the period has a price", () => {
    expect(costCoverage(tally({ pricedEvents: 0, unpricedTokens: 1_000 }))).toBe(
      "No model in this period has a known price. Token totals remain available.",
    );
    expect(costCoverage(tally({ pricedEvents: 0, totalTokens: 0 }))).toBe(SOURCE);
  });
});

describe("displayCost", () => {
  it("shows an estimate once something was priced, and a dash — never $0 — before", () => {
    expect(displayCost({ costUsd: 1.5, pricedEvents: 2, unpricedTokens: 0 })).toBe("≈$1.50");
    expect(displayCost({ costUsd: 0, pricedEvents: 1, unpricedTokens: 0 })).toBe("≈$0.00");
    expect(displayCost({ costUsd: 0, pricedEvents: 0, unpricedTokens: 0 })).toBe("—");
    // Unpriced usage alone is unknown, never free; beside a priced sum it is "+".
    expect(displayCost({ costUsd: 0, pricedEvents: 0, unpricedTokens: 10 })).toBe("—");
    expect(displayCost({ costUsd: 1.5, pricedEvents: 2, unpricedTokens: 10 })).toBe("≈$1.50+");
  });
});
