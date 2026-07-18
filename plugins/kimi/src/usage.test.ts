import { describe, expect, it } from "vitest";
import { normalizeKimiUsages, normalizeKimiWire } from "./usage";

const AT = 1_784_800_000_000;

describe("normalizeKimiWire", () => {
  it("maps a usage.record to tokens and context occupancy", () => {
    const result = normalizeKimiWire(
      {
        agent: "kimi",
        event: {
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 1200,
            output: 300,
            inputCacheRead: 40_000,
            inputCacheCreation: 900,
          },
          usageScope: "turn",
          time: AT,
        },
      },
      AT,
    );
    expect(result?.account).toBeNull();
    expect(result?.pane).toEqual({
      agent: "kimi",
      model: "kimi-code/k3",
      lastTurnTokens: {
        input: 1200,
        output: 300,
        cacheRead: 40_000,
        cacheWrite: 900,
      },
      // The request's full input IS the context occupancy.
      context: { usedTokens: 42_100 },
      reportedAt: AT,
    });
  });

  it("maps a trimmed llm.request to the window size and model", () => {
    const result = normalizeKimiWire(
      {
        agent: "kimi",
        event: { type: "llm.request", model: "kimi-code/k3", maxTokens: 1_048_576 },
      },
      AT,
    );
    expect(result?.pane).toEqual({
      agent: "kimi",
      model: "kimi-code/k3",
      context: { windowTokens: 1_048_576 },
      reportedAt: AT,
    });
  });

  it("returns null for unrecognizable events", () => {
    expect(normalizeKimiWire({ agent: "kimi" }, AT)).toBeNull();
    expect(
      normalizeKimiWire({ agent: "kimi", event: { type: "turn.prompt" } }, AT),
    ).toBeNull();
  });
});

describe("normalizeKimiUsages", () => {
  /** The live response shape: every quota number is a JSON STRING. */
  const BODY = JSON.stringify({
    user: { userId: "u", region: "REGION_OVERSEA" },
    usage: {
      limit: "50",
      used: "12",
      remaining: "38",
      resetTime: "2026-07-21T00:00:00Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "30",
          used: "3",
          remaining: "27",
          resetTime: "2026-07-18T21:00:00Z",
        },
      },
    ],
    parallel: { limit: "20", details: [] },
    totalQuota: { limit: "100", remaining: "80" },
    subType: "TYPE_PURCHASE",
  });

  it("maps rolling windows, the plan window and the quota", () => {
    const account = normalizeKimiUsages(BODY, AT);
    expect(account).toEqual({
      kind: "reported",
      reportedAt: AT,
      sourcePaneId: "",
      windows: [
        {
          usedPct: 10,
          resetsAt: Date.parse("2026-07-18T21:00:00Z"),
          windowMinutes: 300,
        },
        {
          usedPct: 24,
          resetsAt: Date.parse("2026-07-21T00:00:00Z"),
          windowMinutes: null,
        },
        // No `used` on totalQuota — derived from remaining; panel-only scope.
        { usedPct: 20, resetsAt: null, windowMinutes: null, scope: "quota" },
      ],
    });
  });

  it("converts window units and skips malformed entries", () => {
    const account = normalizeKimiUsages(
      JSON.stringify({
        limits: [
          {
            window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: "10", used: "5", resetTime: "2026-07-21T00:00:00Z" },
          },
          { window: { duration: 1, timeUnit: "TIME_UNIT_LIGHTYEAR" }, detail: { limit: "10", used: "1" } },
          { detail: { limit: "0", used: "0" } },
          "garbage",
        ],
      }),
      AT,
    );
    if (account?.kind !== "reported") throw new Error("expected a report");
    expect(account.windows).toEqual([
      {
        usedPct: 50,
        resetsAt: Date.parse("2026-07-21T00:00:00Z"),
        windowMinutes: 10_080,
      },
      { usedPct: 10, resetsAt: null, windowMinutes: null },
    ]);
  });

  it("returns null for garbage or an empty document", () => {
    expect(normalizeKimiUsages("not json", AT)).toBeNull();
    expect(normalizeKimiUsages("{}", AT)).toBeNull();
    expect(normalizeKimiUsages('{"usage":{"limit":"0"}}', AT)).toBeNull();
  });
});
