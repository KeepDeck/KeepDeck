import { describe, expect, it } from "vitest";
import {
  CARRIED_RECORD,
  watchMatches,
  watchProject,
} from "@keepdeck/plugin-api";
import {
  kimiUsageWatches,
  normalizeKimiUsages,
  normalizeKimiWire,
} from "./usage";

const AT = 1_784_800_000_000;

/**
 * One raw wire record, put through the watches kimi actually DECLARES.
 *
 * The two halves have to be tested together or not at all: a `keep` that
 * stopped naming a field the normalizer reads is invisible to a test that
 * hand-builds the carried record, and shows up only as a number that
 * quietly stopped arriving. `sessionTotals` is the host's stamp, added here
 * where the host adds it — onto the carried record.
 */
function tailed(
  record: Record<string, unknown>,
  sessionTotals?: Record<string, unknown>,
) {
  const watch = kimiUsageWatches.find((candidate) =>
    watchMatches(candidate, record),
  );
  if (!watch) throw new Error("no declared watch carries this record");
  const carried = watchProject(watch, record);
  if (sessionTotals) carried.sessionTotals = sessionTotals;
  return {
    agent: "kimi",
    event: { type: CARRIED_RECORD, record: carried, lane: "usage" },
  };
}

describe("normalizeKimiWire", () => {
  it("maps a usage.record to tokens and context occupancy", () => {
    const result = normalizeKimiWire(
      tailed({
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
      }),
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

  it("reads the host's session cumulative into totalTokens", () => {
    const result = normalizeKimiWire(
      tailed(
        {
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 800,
            output: 50,
            inputCacheRead: 41_000,
            inputCacheCreation: 0,
          },
          usageScope: "turn",
          time: AT,
        },
        // Stamped by the host tailer, folded across the session's records
        // by the sum this plugin declared.
        {
          inputOther: 2000,
          output: 350,
          inputCacheRead: 81_000,
          inputCacheCreation: 900,
        },
      ),
      AT,
    );
    // Cumulative in/out for the session — each bucket summed separately.
    expect(result?.pane?.totalTokens).toEqual({
      input: 2000,
      output: 350,
      cacheRead: 81_000,
      cacheWrite: 900,
    });
    // The per-request counts still land as the last turn.
    expect(result?.pane?.lastTurnTokens).toEqual({
      input: 800,
      output: 50,
      cacheRead: 41_000,
      cacheWrite: 0,
    });
  });

  it("maps a trimmed llm.request to the window size and model", () => {
    const result = normalizeKimiWire(
      tailed({
        type: "llm.request",
        model: "kimi-code/k3",
        maxTokens: 1_048_576,
        messages: [{ role: "user", content: "SECRET PROMPT" }],
      }),
      AT,
    );
    expect(result?.pane).toEqual({
      agent: "kimi",
      model: "kimi-code/k3",
      context: { windowTokens: 1_048_576 },
      reportedAt: AT,
    });
  });

  it("prefers the model's alias over its bare id", () => {
    // `usage.record` reports the alias, `llm.request` carries both. Reading
    // the bare id here made one pane label the same model two ways depending
    // on which event landed last.
    const result = normalizeKimiWire(
      tailed({
        type: "llm.request",
        model: "k3-256k",
        modelAlias: "kimi-code/k3-256k",
        maxTokens: 262_144,
      }),
      AT,
    );
    expect(result?.pane?.model).toBe("kimi-code/k3-256k");
  });

  it("falls back to the bare id when no alias came", () => {
    const result = normalizeKimiWire(
      tailed({ type: "llm.request", model: "k3-256k" }),
      AT,
    );
    expect(result?.pane?.model).toBe("k3-256k");
  });

  it("never carries the prompt out of the wire", () => {
    // `llm.request` holds the whole conversation. The declaration names
    // three scalars, so the rest was never copied — the guarantee is
    // structural, not a rule anyone has to remember.
    const carried = tailed({
      type: "llm.request",
      model: "k3-256k",
      maxTokens: 1,
      messages: [{ role: "user", content: "SECRET PROMPT" }],
    });
    expect(JSON.stringify(carried)).not.toContain("SECRET");
    expect(Object.keys(carried.event.record).sort()).toEqual([
      "maxTokens",
      "model",
      "type",
    ]);
  });

  it("counts a compaction's cost without reading it as a turn", () => {
    // kimi scopes the compaction request's own spend to the SESSION, and it
    // sits between full_compaction.begin and .complete on the wire. Its cost
    // is real — the fold takes it, so totalTokens still moves. Its input is
    // the context that was just DISCARDED: read as a turn it would put the
    // pre-compaction size on the gauge at the moment the context emptied
    // (measured live: 305k shown against a real 39k).
    const result = normalizeKimiWire(
      tailed(
        {
          type: "usage.record",
          model: "kimi-code/kimi-for-coding",
          usage: {
            inputOther: 293_569,
            output: 2786,
            inputCacheRead: 11_264,
            inputCacheCreation: 0,
          },
          usageScope: "session",
          time: AT,
        },
        { inputOther: 1_089_817, output: 103_403, inputCacheRead: 46_543_729 },
      ),
      AT,
    );
    expect(result?.pane?.totalTokens).toEqual({
      input: 1_089_817,
      output: 103_403,
      cacheRead: 46_543_729,
    });
    expect(result?.pane?.context).toBeUndefined();
    expect(result?.pane?.lastTurnTokens).toBeUndefined();
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

  it("returns null for garbage or an empty document", () => {
    expect(normalizeKimiUsages("not json", AT)).toBeNull();
    expect(normalizeKimiUsages("{}", AT)).toBeNull();
    expect(normalizeKimiUsages('{"usage":{"limit":"0"}}', AT)).toBeNull();
  });
});
