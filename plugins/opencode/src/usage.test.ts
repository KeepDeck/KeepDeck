import { describe, expect, it } from "vitest";
import { normalizeOpencodeUsage } from "./usage";

const AT = 1_784_800_000_000;

describe("normalizeOpencodeUsage", () => {
  it("maps a reporter usage payload to pane usage, with no account windows", () => {
    const result = normalizeOpencodeUsage(
      {
        agent: "opencode",
        sessionId: "ses_1",
        model: "claude-sonnet-5",
        windowTokens: 200_000,
        contextTokens: 50_000,
        totals: {
          input: 15_000,
          output: 3000,
          reasoning: 200,
          cacheRead: 90_000,
          cacheWrite: 1000,
        },
        lastTurn: {
          input: 800,
          output: 120,
          reasoning: 0,
          cacheRead: 48_000,
          cacheWrite: 0,
        },
        costUsd: 0.42,
      },
      AT,
    );
    // opencode exposes no account rate-limit windows anywhere.
    expect(result?.account).toBeNull();
    expect(result?.pane).toEqual({
      agent: "opencode",
      sessionId: "ses_1",
      model: "claude-sonnet-5",
      context: { usedTokens: 50_000, windowTokens: 200_000 },
      costUsd: 0.42,
      totalTokens: {
        input: 15_000,
        output: 3000,
        reasoning: 200,
        cacheRead: 90_000,
        cacheWrite: 1000,
      },
      lastTurnTokens: {
        input: 800,
        output: 120,
        reasoning: 0,
        cacheRead: 48_000,
        cacheWrite: 0,
      },
      reportedAt: AT,
    });
  });

  it("keeps occupancy tokens when the window size is unknown", () => {
    const result = normalizeOpencodeUsage(
      {
        agent: "opencode",
        model: "x",
        contextTokens: 10_000,
        totals: { input: 1, output: 2 },
      },
      AT,
    );
    // usedTokens with no windowTokens → the host shows tokens without a %.
    expect(result?.pane?.context).toEqual({ usedTokens: 10_000 });
    expect(result?.pane?.totalTokens).toEqual({ input: 1, output: 2 });
    expect(result?.pane?.costUsd).toBeUndefined();
  });

  it("returns null for a non-object payload", () => {
    expect(normalizeOpencodeUsage("nope", AT)).toBeNull();
  });
});
