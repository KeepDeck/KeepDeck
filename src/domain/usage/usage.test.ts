import { describe, expect, it } from "vitest";
import {
  freshest,
  mergePaneUsage,
  normalizeClaudeStatusline,
  normalizeCodexRollout,
  windowExpired,
  type AccountUsage,
} from "./usage";

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
        {
          usedPct: 23.5,
          resetsAt: 1_738_425_600_000,
          windowMinutes: 300,
        },
        {
          usedPct: 41.2,
          resetsAt: 1_738_857_600_000,
          windowMinutes: 10_080,
        },
      ],
    });
    expect(result?.pane).toEqual({
      agent: "claude",
      sessionId: "abc-123",
      model: "Opus",
      context: { usedPct: 8, windowTokens: 200_000 },
      costUsd: 0.01234,
      totalTokens: { input: 15_500, output: 1200 },
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
      windows: [
        {
          usedPct: 66,
          windowMinutes: null,
          scope: "seven_day_fable",
        },
      ],
    });
  });

  it("claims api-key unavailability only once cost proves a response", () => {
    // No rate_limits, no spend yet: too early to tell — no claim.
    const early = normalizeClaudeStatusline(
      report({ cost: { total_cost_usd: 0 } }),
      AT,
    );
    expect(early?.account).toBeNull();
    // No rate_limits but real spend: subscription plans would have the
    // field by now — this is API-key billing.
    const keyed = normalizeClaudeStatusline(
      report({ cost: { total_cost_usd: 0.5 } }),
      AT,
    );
    expect(keyed?.account).toEqual({
      kind: "unavailable",
      reason: "api-key",
      reportedAt: AT,
    });
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

describe("normalizeCodexRollout", () => {
  /** The live 0.144.5 sample: plan "plus" — primary IS the weekly window,
   * secondary is null. Labels must derive from window_minutes downstream. */
  const TOKEN_COUNT = {
    agent: "codex",
    event: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 56_156_584,
          cached_input_tokens: 54_351_616,
          output_tokens: 230_298,
          reasoning_output_tokens: 101_010,
          total_tokens: 56_386_882,
        },
        last_token_usage: {
          input_tokens: 171_784,
          cached_input_tokens: 169_728,
          output_tokens: 63,
          reasoning_output_tokens: 17,
          total_tokens: 171_847,
        },
        model_context_window: 258_400,
      },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 75.0, window_minutes: 10_080, resets_at: 1_784_834_810 },
        secondary: null,
        plan_type: "plus",
      },
    },
  };

  it("maps a weekly-primary plan without inventing a 5h window", () => {
    const result = normalizeCodexRollout(TOKEN_COUNT, AT);
    expect(result?.account).toEqual({
      kind: "reported",
      reportedAt: AT,
      sourcePaneId: "",
      windows: [
        { usedPct: 75, resetsAt: 1_784_834_810_000, windowMinutes: 10_080 },
      ],
    });
    expect(result?.pane).toEqual({
      agent: "codex",
      context: {
        // last_token_usage.total_tokens IS the context occupancy.
        usedPct: (171_847 / 258_400) * 100,
        windowTokens: 258_400,
      },
      totalTokens: {
        input: 56_156_584,
        cacheRead: 54_351_616,
        output: 230_298,
        reasoning: 101_010,
        total: 56_386_882,
      },
      lastTurnTokens: {
        input: 171_784,
        cacheRead: 169_728,
        output: 63,
        reasoning: 17,
        total: 171_847,
      },
      reportedAt: AT,
    });
  });

  it("keeps both windows when a plan has them", () => {
    const both = structuredClone(TOKEN_COUNT);
    both.event.rate_limits = {
      limit_id: "codex",
      primary: { used_percent: 20, window_minutes: 300, resets_at: 1_784_000_000 },
      secondary: { used_percent: 60, window_minutes: 10_080, resets_at: 1_784_834_810 },
      plan_type: "pro",
    } as never;
    expect(normalizeCodexRollout(both, AT)?.account).toMatchObject({
      windows: [{ windowMinutes: 300 }, { windowMinutes: 10_080 }],
    });
  });

  it("survives a null info (early/exec sessions) with limits intact", () => {
    const early = structuredClone(TOKEN_COUNT);
    early.event.info = null as never;
    const result = normalizeCodexRollout(early, AT);
    expect(result?.account).not.toBeNull();
    expect(result?.pane).toEqual({ agent: "codex", reportedAt: AT });
  });

  it("maps turn_context to the pane model with effort", () => {
    const result = normalizeCodexRollout(
      { agent: "codex", event: { type: "turn_context", model: "gpt-5.6-sol", effort: "xhigh" } },
      AT,
    );
    expect(result?.pane).toEqual({
      agent: "codex",
      model: "gpt-5.6-sol xhigh",
      reportedAt: AT,
    });
    expect(result?.account).toBeNull();
  });

  it("returns null for unrecognizable events", () => {
    expect(normalizeCodexRollout({ agent: "codex" }, AT)).toBeNull();
    expect(
      normalizeCodexRollout({ agent: "codex", event: { type: "agent_message" } }, AT),
    ).toBeNull();
  });
});

describe("mergePaneUsage", () => {
  it("lets partial reports complete each other, incoming fields winning", () => {
    const model = { agent: "codex", model: "gpt-5.6-sol xhigh", reportedAt: 1 };
    const numbers = {
      agent: "codex",
      context: { usedPct: 40, windowTokens: 258_400 },
      reportedAt: 2,
    };
    expect(mergePaneUsage(model, numbers)).toEqual({
      agent: "codex",
      model: "gpt-5.6-sol xhigh",
      context: { usedPct: 40, windowTokens: 258_400 },
      reportedAt: 2,
    });
  });

  it("replaces wholesale when the pane changed agents", () => {
    const codex = { agent: "codex", model: "gpt-5.6-sol", reportedAt: 1 };
    const claude = { agent: "claude", reportedAt: 2 };
    expect(mergePaneUsage(codex, claude)).toBe(claude);
    expect(mergePaneUsage(undefined, claude)).toBe(claude);
  });
});

describe("freshest", () => {
  const at = (reportedAt: number): AccountUsage => ({
    kind: "reported",
    windows: [],
    reportedAt,
    sourcePaneId: "",
  });

  it("prefers the newer report and keeps the incumbent on ties", () => {
    expect(freshest(undefined, at(5))).toEqual(at(5));
    expect(freshest(at(5), at(9))).toEqual(at(9));
    expect(freshest(at(9), at(5))).toEqual(at(9));
    const incumbent = at(7);
    expect(freshest(incumbent, at(7))).toBe(incumbent);
  });
});

describe("windowExpired", () => {
  it("expires only once the reset instant passes", () => {
    const window = { usedPct: 50, resetsAt: 1000, windowMinutes: 300 };
    expect(windowExpired(window, 999)).toBe(false);
    expect(windowExpired(window, 1000)).toBe(true);
    expect(windowExpired({ ...window, resetsAt: null }, 5000)).toBe(false);
  });
});
