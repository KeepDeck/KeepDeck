import { describe, expect, it } from "vitest";
import { estimateUsageCost, PRICING_VERSION } from "./pricing";

describe("estimateUsageCost", () => {
  it("prices an exact Codex model and does not double-charge cached input", () => {
    expect(
      estimateUsageCost("codex", "gpt-5.6-sol xhigh", {
        input: 1_000_000,
        cacheRead: 800_000,
        output: 100_000,
        reasoning: 90_000,
      }),
    ).toEqual({
      // 200k fresh × $5 + 800k cached × $0.50 + 100k output × $30.
      usd: 4.4,
      pricingVersion: PRICING_VERSION,
    });
  });

  it("prices explicit GPT-5.6 cache writes at 1.25x input", () => {
    expect(
      estimateUsageCost("codex", "gpt-5.6-terra", { cacheWrite: 1_000_000 })
        ?.usd,
    ).toBe(3.125);
  });

  it("refuses unknown models, other agents and empty token bags", () => {
    expect(estimateUsageCost("codex", "future-model", { input: 10 })).toBeNull();
    expect(estimateUsageCost("kimi", "gpt-5.6-sol", { input: 10 })).toBeNull();
    expect(estimateUsageCost("codex", "gpt-5.6-sol", {})).toBeNull();
  });
});
