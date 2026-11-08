import { describe, expect, it } from "vitest";
import { normalizeOpencodeUsage } from "./usage";

const AT = 1_784_800_000_000;

/** A step as the 1.x reporter states it: a `step-finish` part, with the
 * model and creation time of its message. */
const STEP = {
  id: "prt_01",
  sessionID: "ses_child",
  providerID: "zai-coding-plan",
  modelID: "glm-5.3",
  created: 1_784_700_000_000,
  tokens: { input: 800, output: 120, reasoning: 30, cache: { read: 48_000, write: 0 } },
};

describe("normalizeOpencodeUsage", () => {
  it("maps the pane's context, with no account windows", () => {
    const result = normalizeOpencodeUsage(
      {
        agent: "opencode",
        sessionId: "ses_root",
        sequence: 7,
        windowTokens: 200_000,
        contextTokens: 50_000,
      },
      AT,
    );
    // opencode exposes no account rate-limit windows anywhere.
    expect(result).toEqual({
      account: null,
      pane: {
        agent: "opencode",
        sessionId: "ses_root",
        sequence: 7,
        context: { usedTokens: 50_000, windowTokens: 200_000 },
        reportedAt: AT,
      },
    });
  });

  it("keeps occupancy tokens when the window size is unknown", () => {
    const result = normalizeOpencodeUsage({ agent: "opencode", contextTokens: 10_000 }, AT);
    // usedTokens with no windowTokens → the host shows tokens without a %.
    expect(result?.pane?.context).toEqual({ usedTokens: 10_000 });
  });

  it("books each step as a call, its reasoning billed as output", () => {
    const result = normalizeOpencodeUsage({ agent: "opencode", sequence: 8, steps: [STEP] }, AT);
    expect(result?.calls).toEqual([
      {
        id: "prt_01",
        at: 1_784_700_000_000,
        provider: "zai-coding-plan",
        model: "glm-5.3",
        tokens: { input: 800, cacheRead: 48_000, cacheWrite: 0, output: 150, reasoning: 30 },
      },
    ]);
  });

  it("books no call for a step without its id, model, provider or time", () => {
    const broken = ["id", "modelID", "providerID", "created"].map((key) => {
      const step: Record<string, unknown> = { ...STEP };
      delete step[key];
      return step;
    });
    const result = normalizeOpencodeUsage({ agent: "opencode", steps: broken }, AT);
    expect(result?.calls).toBeUndefined();
  });

  it("returns null for a non-object payload", () => {
    expect(normalizeOpencodeUsage("nope", AT)).toBeNull();
  });
});
