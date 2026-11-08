import { describe, expect, it } from "vitest";
import {
  CARRIED_RECORD,
  watchMatches,
  watchProject,
} from "@keepdeck/plugin-api";
import {
  kimiAgentsDirectory,
  kimiUsageWatches,
  normalizeKimiUsages,
  normalizeKimiWire,
} from "./usage";

const AT = 1_784_800_000_000;

/**
 * One raw wire record, put through the watch kimi actually DECLARES for
 * `lane` — and, for a call, the context the host would have attached: the
 * latest `llm.request`, through ITS watch.
 *
 * The two halves have to be tested together or not at all: a `keep` that
 * stopped naming a field the normalizer reads is invisible to a test that
 * hand-builds the carried record, and shows up only as a number that
 * quietly stopped arriving.
 */
function tailed(
  record: Record<string, unknown>,
  lane: "usage" | "calls" = "usage",
  request?: Record<string, unknown>,
) {
  const watch = kimiUsageWatches.find(
    (candidate) => candidate.lane === lane && !candidate.context && watchMatches(candidate, record),
  );
  if (!watch) throw new Error(`no declared ${lane} watch carries this record`);
  const contextWatch = kimiUsageWatches.find((candidate) => candidate.context);
  return {
    agent: "kimi",
    sourceAt: record.time,
    sourceRef: { file: "/s/agents/main/wire.jsonl", offset: 120 },
    event: {
      type: CARRIED_RECORD,
      record: watchProject(watch, record),
      lane,
      ...(request && contextWatch ? { context: watchProject(contextWatch, request) } : {}),
    },
  };
}

const RECORD = {
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
};

const REQUEST = {
  type: "llm.request",
  model: "k3-256k",
  modelAlias: "kimi-code/k3-256k",
  maxTokens: 262_144,
  messages: [{ role: "user", content: "SECRET PROMPT" }],
};

describe("normalizeKimiWire", () => {
  it("reads a usage.record as the pane's context occupancy", () => {
    const result = normalizeKimiWire(tailed(RECORD), AT);
    expect(result).toEqual({
      account: null,
      // The request's full input IS the context occupancy.
      pane: { agent: "kimi", context: { usedTokens: 42_100 }, reportedAt: AT },
    });
  });

  it("books a usage.record as one call, its place in the wire its id", () => {
    const result = normalizeKimiWire(tailed(RECORD, "calls", REQUEST), AT);
    expect(result).toEqual({
      account: null,
      pane: null,
      calls: [
        {
          id: "/s/agents/main/wire.jsonl#120",
          at: AT,
          provider: "kimi-code",
          // The bare id the request went to, not kimi's alias for it.
          model: "k3-256k",
          tokens: { input: 1200, cacheRead: 40_000, cacheWrite: 900, output: 300 },
        },
      ],
    });
  });

  it("books under kimi's alias only before any request has named the model", () => {
    const calls = normalizeKimiWire(tailed(RECORD, "calls"), AT)?.calls;
    expect(calls?.[0]?.model).toBe("kimi-code/k3");
  });

  it("books no call without its place or its time", () => {
    const carried = tailed(RECORD, "calls", REQUEST);
    expect(normalizeKimiWire({ ...carried, sourceRef: undefined }, AT)?.calls).toEqual([]);
    expect(normalizeKimiWire({ ...carried, sourceAt: undefined }, AT)?.calls).toEqual([]);
  });

  it("reads a trimmed llm.request as the window size", () => {
    expect(normalizeKimiWire(tailed(REQUEST), AT)?.pane).toEqual({
      agent: "kimi",
      context: { windowTokens: 262_144 },
      reportedAt: AT,
    });
  });

  it("never carries the prompt out of the wire", () => {
    // `llm.request` holds the whole conversation. Each declaration names a
    // few scalars, so the rest was never copied — the guarantee is
    // structural, not a rule anyone has to remember.
    const gauge = tailed(REQUEST);
    const call = tailed(RECORD, "calls", REQUEST);
    expect(JSON.stringify([gauge, call])).not.toContain("SECRET");
    expect(Object.keys(gauge.event.record).sort()).toEqual(["maxTokens", "type"]);
  });

  it("books a compaction's cost without reading it as a turn", () => {
    // kimi scopes the compaction request's own spend to the SESSION, and it
    // sits between full_compaction.begin and .complete on the wire. Its cost
    // is real — it is a call like any other. Its input is the context that
    // was just DISCARDED: read as a turn it would put the pre-compaction
    // size on the gauge at the moment the context emptied (measured live:
    // 305k shown against a real 39k).
    const compaction = {
      ...RECORD,
      model: "kimi-code/kimi-for-coding",
      usage: { inputOther: 293_569, output: 2786, inputCacheRead: 11_264, inputCacheCreation: 0 },
      usageScope: "session",
    };
    expect(normalizeKimiWire(tailed(compaction), AT)?.pane).toBeNull();
    expect(normalizeKimiWire(tailed(compaction, "calls"), AT)?.calls?.[0]?.tokens.input).toBe(293_569);
  });

  it("names the session's agents directory as the siblings of its main wire", () => {
    expect(kimiAgentsDirectory("/h/sessions/wd_x/session_1/agents/main/wire.jsonl")).toBe(
      "/h/sessions/wd_x/session_1/agents",
    );
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
        // The document reports no duration for the plan window — the
        // normalizer stamps it weekly (kimi console: "Weekly usage").
        {
          usedPct: 24,
          resetsAt: Date.parse("2026-07-21T00:00:00Z"),
          windowMinutes: 10_080,
        },
        // No `used` on totalQuota — derived from remaining; panel-only scope.
        { usedPct: 20, resetsAt: null, windowMinutes: null, scope: "quota" },
      ],
    });
  });

  it("keeps a limit row's own name, so a window is not just a duration", () => {
    // kimi labels its limit windows; dropping the label left the panel
    // showing "5h" with nothing saying what it limits.
    const account = normalizeKimiUsages(
      JSON.stringify({
        limits: [
          {
            name: "requests",
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "30", used: "3" },
          },
        ],
      }),
      AT,
    );
    if (account?.kind !== "reported") throw new Error("expected a report");
    expect(account.windows[0]).toMatchObject({ scope: "requests" });
  });

  it("leaves a nameless limit row nameless rather than inventing one", () => {
    const account = normalizeKimiUsages(
      JSON.stringify({
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "30", used: "3" },
          },
        ],
      }),
      AT,
    );
    if (account?.kind !== "reported") throw new Error("expected a report");
    expect("scope" in account.windows[0]).toBe(false);
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

  it("reports a count-derived percentage without float residue, sub-percent kept", () => {
    // 7/100*100 is 7.000000000000001 in floating point — it reached the
    // window journal verbatim. Rounding must not erase a real 0.4% either.
    const account = normalizeKimiUsages(
      JSON.stringify({
        usage: { limit: "100", used: "7" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "16000", used: "64" },
          },
        ],
      }),
      AT,
    );
    if (account?.kind !== "reported") throw new Error("expected a report");
    expect(account.windows.map((window) => window.usedPct)).toEqual([0.4, 7]);
  });

  it("returns null for garbage or an empty document", () => {
    expect(normalizeKimiUsages("not json", AT)).toBeNull();
    expect(normalizeKimiUsages("{}", AT)).toBeNull();
    expect(normalizeKimiUsages('{"usage":{"limit":"0"}}', AT)).toBeNull();
  });
});
