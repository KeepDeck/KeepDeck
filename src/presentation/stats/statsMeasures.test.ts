import { describe, expect, it } from "vitest";
import { displayAmount, formatAmount, measureNote, windowLedgerCaption } from "./statsMeasures";

const tally = { costUsd: 1.5, pricedEvents: 3, approximateEvents: 0, unpricedTokens: 0, tokensLessCacheReads: 2_400 };

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

describe("windowLedgerCaption", () => {
  const ledger = { ...tally, totalTokens: 15_500, sessionCount: 2 };

  it("says what the window's sessions used and, once one was priced, cost", () => {
    expect(windowLedgerCaption(ledger, "spend")).toBe("15.5k · 2 sessions · ≈$1.50 this window");
    expect(windowLedgerCaption({ ...ledger, sessionCount: 1, pricedEvents: 0 }, "spend")).toBe("15.5k · 1 session this window");
    expect(windowLedgerCaption({ ...ledger, sessionCount: 0 }, "spend")).toBe("no usage this window");
  });

  it("says the window's tokens less cache reads in tokens, priced or not", () => {
    expect(windowLedgerCaption({ ...ledger, pricedEvents: 0 }, "tokens")).toBe("2.4k tokens · 2 sessions this window");
    expect(windowLedgerCaption({ ...ledger, sessionCount: 0 }, "tokens")).toBe("no usage this window");
  });
});
