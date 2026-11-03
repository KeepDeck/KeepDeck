import { describe, expect, it } from "vitest";
import { addTokenCounts, providerCostOf, tokenTotal, usageSessionKey } from "./event";
import { usageEvent } from "./event.testSupport";

describe("usage row helpers", () => {
  it("uses a source total when present and otherwise sums buckets", () => {
    expect(tokenTotal({ input: 10, output: 2, cacheRead: 4 })).toBe(16);
    expect(tokenTotal({ total: 99, input: 10 })).toBe(99);
  });

  it("adds counts field by field, leaving a field nobody reported absent", () => {
    const into = { input: 1 };
    addTokenCounts(into, { input: 2, cacheRead: 3 });
    expect(into).toEqual({ input: 3, cacheRead: 3 });
  });

  it("prices a row only from a provider-reported cost", () => {
    expect(providerCostOf(usageEvent({ costSource: "provider", costUsd: 0.5 }))).toBe(0.5);
    expect(providerCostOf(usageEvent({ costSource: "unavailable" }))).toBeNull();
  });

  it("keys a session by agent and session id together", () => {
    expect(usageSessionKey({ agent: "claude", sessionId: "s" })).not.toBe(
      usageSessionKey({ agent: "codex", sessionId: "s" }),
    );
  });
});
