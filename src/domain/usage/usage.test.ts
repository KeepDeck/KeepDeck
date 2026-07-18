import { describe, expect, it } from "vitest";
import {
  contextPct,
  freshest,
  mergePaneUsage,
  windowExpired,
  type AccountUsage,
} from "./usage";

/* The per-agent normalizers live (and are tested) with their plugins; this
 * file covers what no plugin decides — how reports combine. */

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

  it("merges the context bag field-wise — kimi splits window from tokens", () => {
    const windowOnly = {
      agent: "kimi",
      model: "kimi-code/k3",
      context: { windowTokens: 1_048_576 },
      reportedAt: 1,
    };
    const tokensOnly = {
      agent: "kimi",
      context: { usedTokens: 42_100 },
      reportedAt: 2,
    };
    expect(mergePaneUsage(windowOnly, tokensOnly)).toEqual({
      agent: "kimi",
      model: "kimi-code/k3",
      context: { windowTokens: 1_048_576, usedTokens: 42_100 },
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

describe("contextPct", () => {
  it("resolves whichever terms the CLI spoke", () => {
    expect(contextPct({ usedPct: 62 })).toBe(62);
    expect(contextPct({ usedTokens: 262_144, windowTokens: 1_048_576 })).toBe(25);
    expect(contextPct({ usedTokens: 2_000_000, windowTokens: 1_048_576 })).toBe(100);
  });

  it("stays undefined while a half is missing", () => {
    expect(contextPct(undefined)).toBeUndefined();
    expect(contextPct({ usedTokens: 42 })).toBeUndefined();
    expect(contextPct({ windowTokens: 1000 })).toBeUndefined();
    expect(contextPct({ usedTokens: 42, windowTokens: 0 })).toBeUndefined();
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
