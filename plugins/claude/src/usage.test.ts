import { describe, expect, it } from "vitest";
import { normalizeClaudeStatusline } from "./usage";

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
    expect(result?.pane).toEqual({
      agent: "claude",
      sessionId: "abc-123",
      model: "Opus",
      context: { usedPct: 8, windowTokens: 200_000 },
      costUsd: 0.01234,
      lastTurnTokens: {
        input: 8500,
        output: 1200,
        cacheRead: 2000,
        cacheWrite: 5000,
      },
      reportedAt: AT,
    });
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

  it("maps transcript-tail cumulatives into durable token totals", () => {
    const result = normalizeClaudeStatusline(
      {
        agent: "claude",
        event: {
          type: "assistant.usage",
          sessionTotals: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 40,
          },
        },
      },
      AT,
    );
    expect(result).toEqual({
      account: null,
      pane: {
        agent: "claude",
        totalTokens: {
          input: 10,
          output: 20,
          cacheRead: 300,
          cacheWrite: 40,
        },
        reportedAt: AT,
      },
    });
  });

  it("never claims unavailability from cost — resumed sessions carry cost first", () => {
    // A resumed Max session's very first update: accumulated cost, no
    // rate_limits YET. This must stay a non-claim, not become "api-key".
    const resumed = normalizeClaudeStatusline(
      report({ cost: { total_cost_usd: 0.5 } }),
      AT,
    );
    expect(resumed?.account).toBeNull();
    expect(resumed?.pane?.costUsd).toBe(0.5);
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

  it("omits token bags entirely when the payload carries no counts", () => {
    const result = normalizeClaudeStatusline(
      report({ model: { display_name: "Opus" } }),
      AT,
    );
    expect(result?.pane).toEqual({
      agent: "claude",
      model: "Opus",
      reportedAt: AT,
    });
  });
});
