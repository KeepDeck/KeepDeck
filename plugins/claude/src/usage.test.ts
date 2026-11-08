import { describe, expect, it } from "vitest";
import {
  CARRIED_RECORD,
  watchMatches,
  watchProject,
} from "@keepdeck/plugin-api";
import { claudeUsageWatches, normalizeClaudeStatusline } from "./usage";
import { present } from "@keepdeck/plugin-api/testing";

/** The documented statusLine stdin (docs 2.1.x), as the reporter forwards
 * it — payload shape `{agent, statusline}`. */
const report = (statusline: unknown) => ({ agent: "claude", statusline });

const FULL = {
  session_id: "abc-123",
  transcript_path: "/tmp/t.jsonl",
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  cost: { total_cost_usd: 0.01234, total_duration_ms: 45_000 },
  context_window: {
    total_input_tokens: 15_500,
    total_output_tokens: 1200,
    context_window_size: 200_000,
    used_percentage: 8,
    remaining_percentage: 92,
    current_usage: {
      input_tokens: 8500,
      output_tokens: 1200,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 2000,
    },
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
    seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
  },
};

const AT = 1_738_400_000_000;

describe("normalizeClaudeStatusline", () => {
  it("maps the documented payload to account windows and pane usage", () => {
    const result = normalizeClaudeStatusline(report(FULL), AT);
    expect(result?.account).toEqual({
      kind: "reported",
      reportedAt: AT,
      sourcePaneId: "",
      windows: [
        { usedPct: 23.5, resetsAt: 1_738_425_600_000, windowMinutes: 300 },
        { usedPct: 41.2, resetsAt: 1_738_857_600_000, windowMinutes: 10_080 },
      ],
    });
    // The pane's live state only: what it spent travels as calls.
    expect(result?.pane).toEqual({
      agent: "claude",
      sessionId: "abc-123",
      context: { usedPct: 8, windowTokens: 200_000 },
      reportedAt: AT,
    });
    expect(result?.calls).toBeUndefined();
  });

  it("gates the account behind the session's API cumulatives", () => {
    const witnessed = {
      ...FULL,
      cost: { ...FULL.cost, total_api_duration_ms: 12_000 },
    };
    expect(normalizeClaudeStatusline(report(witnessed), AT)?.accountActivity).toEqual({
      sessionId: "abc-123",
      costUsd: 0.01234,
      apiDurationMs: 12_000,
    });
    // Context and current-turn tokens are no witness: they describe the
    // current response. Without the API time the gate stays shut — `null`,
    // never an ungated claim.
    expect(normalizeClaudeStatusline(report(FULL), AT)?.accountActivity).toBeNull();
    const { session_id: _omitted, ...sessionless } = witnessed;
    expect(
      normalizeClaudeStatusline(report(sessionless), AT)?.accountActivity,
    ).toBeNull();
    // A negative counter is no reading at all.
    for (const cost of [
      { ...witnessed.cost, total_cost_usd: -0.5 },
      { ...witnessed.cost, total_api_duration_ms: -1 },
    ]) {
      expect(
        normalizeClaudeStatusline(report({ ...witnessed, cost }), AT)?.accountActivity,
      ).toBeNull();
    }
    // Even a report with no limits declares the gate.
    const { rate_limits: _none, ...limitless } = witnessed;
    const result = normalizeClaudeStatusline(report(limitless), AT);
    expect(result?.account).toBeNull();
    expect(result?.accountActivity).not.toBeUndefined();
  });

  it("keeps unknown rate-limit keys as scoped windows instead of dropping them", () => {
    const result = normalizeClaudeStatusline(
      report({
        rate_limits: {
          seven_day_fable: { used_percentage: 66, resets_at: 1_738_857_600 },
        },
      }),
      AT,
    );
    expect(result?.account).toMatchObject({
      kind: "reported",
      windows: [{ usedPct: 66, windowMinutes: null, scope: "seven_day_fable" }],
    });
  });

  /** A transcript row as the host carries it: the fields the watch keeps,
   * the row's own time, its place in the file. */
  const row = (fields: Record<string, unknown>, sourceAt: unknown = "2026-10-18T14:13:52.763Z") =>
    normalizeClaudeStatusline(
      {
        agent: "claude",
        sourceAt,
        sourceRef: { file: "/t.jsonl", offset: 7 },
        event: { type: CARRIED_RECORD, lane: "calls", record: fields },
      },
      AT,
    );

  /** A `cost-state` row as the host carries it, with the latest dated row
   * before it held as its context. */
  const costState = (fields: Record<string, unknown>, context: Record<string, unknown> | null) =>
    normalizeClaudeStatusline(
      {
        agent: "claude",
        sourceRef: { file: "/t.jsonl", offset: 9 },
        event: { type: CARRIED_RECORD, lane: "calls", record: fields, ...(context ? { context } : {}) },
      },
      AT,
    );

  /** claude 2.1.319's per-model counts in a cost-state row (abridged). */
  const OPUS_COUNTS = {
    inputTokens: 3_088,
    outputTokens: 155_370,
    thinkingTokens: 4_000,
    cacheReadInputTokens: 80_519_730,
    cacheCreationInputTokens: 308_947,
    cacheCreationEphemeral5mInputTokens: 411,
    cacheCreationEphemeral1hInputTokens: 308_536,
    webSearchRequests: 0,
    costUSD: 21.69,
  };

  it("reads a cost-state row as claude's running totals, one per model, dated by the row before it", () => {
    const result = costState(
      {
        startTime: 1_793_222_062_165,
        modelUsage: {
          "claude-opus-5-5[1m]": OPUS_COUNTS,
          "claude-opus-5-5": { inputTokens: 12, outputTokens: 30 },
          "claude-haiku-5-5": { inputTokens: 74_878, outputTokens: 7_011, thinkingTokens: 100 },
        },
      },
      { timestamp: "2026-11-08T20:41:17.000Z" },
    );
    const at = Date.parse("2026-11-08T20:41:17.000Z");
    expect(result?.calls).toEqual([
      {
        id: "1793222062165:claude-opus-5-5",
        at,
        provider: "anthropic",
        model: "claude-opus-5-5",
        tokens: {
          input: 3_100,
          cacheRead: 80_519_730,
          cacheWrite: 411,
          cacheWrite1h: 308_536,
          output: 155_400,
          reasoning: 4_000,
        },
        tally: { began: 1_793_222_062_165 },
      },
      {
        id: "1793222062165:claude-haiku-5-5",
        at,
        provider: "anthropic",
        model: "claude-haiku-5-5",
        tokens: { input: 74_878, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 7_011, reasoning: 100 },
        tally: { began: 1_793_222_062_165 },
      },
    ]);
  });

  it("splits a cost-state write it does not split itself as all five-minute", () => {
    const result = costState(
      { startTime: 1, modelUsage: { "claude-sonnet-5-5": { cacheCreationInputTokens: 900, cacheCreationEphemeral1hInputTokens: 0 } } },
      { timestamp: "2026-11-08T20:41:17.000Z" },
    );
    expect(result?.calls?.[0]?.tokens).toMatchObject({ cacheWrite: 900, cacheWrite1h: 0 });
  });

  it("books no total it cannot date, nor one without a count's start", () => {
    const fields = { startTime: 1, modelUsage: { "claude-opus-5-5": OPUS_COUNTS } };
    expect(costState(fields, null)?.calls).toEqual([]);
    expect(costState(fields, { timestamp: "not a time" })?.calls).toEqual([]);
    expect(costState({ modelUsage: fields.modelUsage }, { timestamp: "2026-11-08T20:41:17.000Z" })?.calls).toEqual([]);
  });

  it("watches cost-state rows, and holds the latest dated row other than a call for them", () => {
    const first = (row: Record<string, unknown>) => claudeUsageWatches.find((watch) => watchMatches(watch, row));
    const assistant = { type: "assistant", timestamp: "2026-11-08T20:41:00.000Z", message: { id: "m", usage: {} } };
    expect(first(assistant)?.keep).toContain("message.usage");
    const total = { type: "cost-state", sessionId: "s", startTime: 1, modelUsage: {}, totalCostUSD: 1 };
    expect(watchProject(present(first(total), "the cost-state watch"), total)).toEqual({ startTime: 1, modelUsage: {} });
    const bookkeeping = { type: "system", subtype: "turn_duration", timestamp: "2026-11-08T20:41:17.000Z", durationMs: 5 };
    const held = present(first(bookkeeping), "the dating watch");
    expect(held.context).toBe(true);
    expect(watchProject(held, bookkeeping)).toEqual({ timestamp: "2026-11-08T20:41:17.000Z" });
  });

  /** A real claude 2.1.319 usage block, its 1-hour write split out. */
  const USAGE = {
    input_tokens: 2,
    cache_creation_input_tokens: 21_824,
    cache_read_input_tokens: 16_090,
    output_tokens: 302,
    output_tokens_details: { thinking_tokens: 24 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 21_824, ephemeral_5m_input_tokens: 0 },
    iterations: [{ type: "message", input_tokens: 2, output_tokens: 302 }],
    speed: "standard",
  };

  it("maps an assistant row into its call, the cache write split by how long it is held", () => {
    expect(
      row({ "message.id": "msg_011", "message.model": "claude-opus-5-5", "message.usage": USAGE }),
    ).toEqual({
      account: null,
      pane: null,
      calls: [
        {
          id: "msg_011",
          at: Date.parse("2026-10-18T14:13:52.763Z"),
          provider: "anthropic",
          model: "claude-opus-5-5",
          tokens: { input: 2, cacheRead: 16_090, cacheWrite: 0, cacheWrite1h: 21_824, output: 302, reasoning: 24 },
        },
      ],
    });
  });

  it("books an unsplit cache write as the 5-minute write, and fast mode as its mode", () => {
    const { cache_creation: _split, ...unsplit } = USAGE;
    const calls = row({
      "message.id": "msg_012",
      "message.model": "claude-opus-5-5[1m]",
      "message.usage": { ...unsplit, speed: "fast" },
    })?.calls;
    expect(calls?.[0]).toMatchObject({
      model: "claude-opus-5-5",
      mode: "fast",
      tokens: { cacheWrite: 21_824, cacheWrite1h: 0 },
    });
  });

  it("books each advisor escalation as a call of its own, under the advisor's model", () => {
    const calls = row({
      "message.id": "msg_013",
      "message.model": "claude-sonnet-5-5",
      "message.usage": {
        ...USAGE,
        iterations: [
          { type: "message", input_tokens: 2, output_tokens: 302 },
          { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 900, output_tokens: 40 },
          { type: "advisor_message", input_tokens: 5, output_tokens: 1 },
        ],
      },
    })?.calls;
    expect(calls?.map((call) => [call.id, call.model, call.tokens.input])).toEqual([
      ["msg_013", "claude-sonnet-5-5", 2],
      ["msg_013:advisor:0", "claude-opus-5-5", 900],
      ["msg_013:advisor:1", "claude-sonnet-5-5", 5],
    ]);
  });

  it("books no call for a message claude wrote itself, or one without its time", () => {
    const fields = { "message.id": "msg_014", "message.usage": USAGE };
    expect(row({ ...fields, "message.model": "<synthetic>" })?.calls).toEqual([]);
    expect(row({ ...fields, "message.model": "claude-opus-5-5" }, null)?.calls).toEqual([]);
  });

  it("declares a transcript watch that carries a call's counts and never its content", () => {
    // The pairing that matters: the watch matches an assistant row carrying
    // counts, and `keep` names the id, model and usage block — no content —
    // so the conversation cannot ride out of a transcript, structurally
    // rather than by rule.
    const transcriptRow = {
      type: "assistant",
      message: {
        id: "msg-1",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "SECRET ANSWER" }],
        usage: { input_tokens: 12, output_tokens: 30 },
      },
    };
    const watch = claudeUsageWatches.find((candidate) =>
      watchMatches(candidate, transcriptRow),
    );
    expect(watch?.lane).toBe("calls");
    expect(watchProject(present(watch, "the watcher"), transcriptRow)).toEqual({
      "message.id": "msg-1",
      "message.model": "claude-opus-5-5",
      "message.usage": { input_tokens: 12, output_tokens: 30 },
    });
    // And a row with no counts at all is not carried.
    expect(
      claudeUsageWatches.some((candidate) =>
        watchMatches(candidate, { type: "assistant", message: { id: "x" } }),
      ),
    ).toBe(false);
  });

  it("never claims unavailability from cost — resumed sessions carry cost first", () => {
    // A resumed Max session's very first update: accumulated cost, no
    // rate_limits YET. This must stay a non-claim, not become "api-key".
    const resumed = normalizeClaudeStatusline(
      report({ cost: { total_cost_usd: 0.5 } }),
      AT,
    );
    expect(resumed?.account).toBeNull();
    expect(resumed?.pane).toEqual({ agent: "claude", reportedAt: AT });
  });

  it("clamps percentages and survives malformed windows", () => {
    const result = normalizeClaudeStatusline(
      report({
        rate_limits: {
          five_hour: { used_percentage: 120, resets_at: 1_738_425_600 },
          seven_day: { used_percentage: "broken" },
          garbage: "not a window",
        },
      }),
      AT,
    );
    expect(result?.account).toMatchObject({
      kind: "reported",
      windows: [{ usedPct: 100, windowMinutes: 300 }],
    });
  });

  it("returns null for unrecognizable payloads", () => {
    expect(normalizeClaudeStatusline(null, AT)).toBeNull();
    expect(normalizeClaudeStatusline({ agent: "claude" }, AT)).toBeNull();
    expect(
      normalizeClaudeStatusline({ agent: "claude", statusline: "nope" }, AT),
    ).toBeNull();
  });

  it("omits the context entirely when the payload carries none", () => {
    const result = normalizeClaudeStatusline(
      report({ model: { display_name: "Opus" } }),
      AT,
    );
    expect(result?.pane).toEqual({
      agent: "claude",
      reportedAt: AT,
    });
  });
});
