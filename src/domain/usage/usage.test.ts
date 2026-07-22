import { describe, expect, it } from "vitest";
import {
  contextPct,
  freshest,
  hydrateUsageCache,
  mergePaneUsage,
  serializeUsageCache,
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

  it("replaces wholesale when an identified session changes", () => {
    const oldSession = {
      agent: "opencode",
      sessionId: "session-old",
      model: "old-model",
      sequence: 12,
      costUsd: 9,
      reportedAt: 1,
    };
    const newSession = {
      agent: "opencode",
      sessionId: "session-new",
      sequence: 1,
      costUsd: 0.1,
      reportedAt: 2,
    };

    expect(mergePaneUsage(oldSession, newSession)).toBe(newSession);
  });

  it("rejects an older sequence inside the same session", () => {
    const current = {
      agent: "opencode",
      sessionId: "session-1",
      sequence: 3,
      costUsd: 0.3,
      reportedAt: 3,
    };
    const delayed = {
      agent: "opencode",
      sessionId: "session-1",
      sequence: 2,
      costUsd: 0.2,
      reportedAt: 4,
    };

    expect(mergePaneUsage(current, delayed)).toBe(current);
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

describe("usage cache", () => {
  const reported: AccountUsage = {
    kind: "reported",
    windows: [
      { usedPct: 42, resetsAt: 1_738_425_600_000, windowMinutes: 300 },
      { usedPct: 20, resetsAt: null, windowMinutes: null, scope: "quota" },
    ],
    reportedAt: 1_738_400_000_000,
    sourcePaneId: "pane-7",
  };

  it("round-trips accounts, blanking the pane attribution", () => {
    const json = serializeUsageCache(new Map([["claude", reported]]));
    const back = hydrateUsageCache(json);
    expect(back.get("claude")).toEqual({
      ...reported,
      sourcePaneId: "",
    });
  });

  it("drops damaged entries individually and survives garbage", () => {
    const json = JSON.stringify({
      version: 1,
      accounts: {
        good: { kind: "reported", reportedAt: 5, windows: [{ usedPct: 120 }] },
        noWindows: { kind: "reported", reportedAt: 5, windows: [] },
        badPct: { kind: "reported", reportedAt: 5, windows: [{ usedPct: "x" }] },
        unavailable: { kind: "unavailable", reason: "api-key", reportedAt: 5 },
        junk: 7,
      },
    });
    const back = hydrateUsageCache(json);
    expect([...back.keys()]).toEqual(["good"]);
    expect(back.get("good")?.kind === "reported").toBe(true);
    if (back.get("good")?.kind === "reported") {
      expect(back.get("good")).toMatchObject({
        windows: [{ usedPct: 100, resetsAt: null, windowMinutes: null }],
      });
    }
    expect(hydrateUsageCache("not json").size).toBe(0);
    expect(hydrateUsageCache("{}").size).toBe(0);
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
