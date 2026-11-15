import { describe, expect, it } from "vitest";
import { DEFAULT_STATS_MEASURE, displayAmount, formatAmount, measureNote } from "./statsMeasures";

const tally = { costUsd: 1.5, pricedEvents: 3, approximateEvents: 0, unpricedTokens: 0, tokensLessCacheReads: 2_400 };

describe("the measure Statistics opens on", () => {
  it("is tokens — work every row has — until the reader picks money", () => {
    expect(DEFAULT_STATS_MEASURE).toBe("tokens");
  });
});

describe("an amount in a measure", () => {
  it("says a tally as money — never free, marked when part is unpriced — or as tokens less cache reads", () => {
    expect([displayAmount(tally, "spend"), displayAmount(tally, "tokens")]).toEqual(["≈$1.50", "2.4k"]);
    expect(displayAmount({ ...tally, pricedEvents: 0 }, "spend")).toBe("—");
    expect(displayAmount({ ...tally, unpricedTokens: 9 }, "spend")).toBe("≈$1.50+");
    expect([formatAmount(2, "spend"), formatAmount(1_500_000, "tokens")]).toEqual(["≈$2.00", "1.5M"]);
  });

  it("notes the money's source, or what a token figure leaves out", () => {
    expect(measureNote({ ...tally, totalTokens: 2_400 }, "spend")).toMatch(/^Costs are estimated/);
    expect(measureNote({ ...tally, totalTokens: 2_400 }, "tokens")).toBe(
      "Tokens count fresh input, output with its reasoning and cache writes; what was read back from cache is left out.",
    );
  });
});
