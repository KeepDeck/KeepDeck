import { describe, expect, it } from "vitest";
import { normalizeCodexRollout } from "./usage";

const AT = 1_738_400_000_000;

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

describe("normalizeCodexRollout", () => {
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
