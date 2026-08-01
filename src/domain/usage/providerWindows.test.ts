import { describe, expect, it } from "vitest";
import { providerWindowGroups, providerWindowRows } from "./providerWindows";
import type { AccountUsage, UsageWindow } from "./usage";

import { TEST_NOW, usageEvent as event } from "./history.testSupport";

const NOW = TEST_NOW;
const HOUR = 3_600_000;

const reported = (
  windows: UsageWindow[],
  reportedAt = NOW - 60_000,
): AccountUsage => ({
  kind: "reported",
  windows,
  reportedAt,
  sourcePaneId: "pane-1",
});


describe("providerWindowRows", () => {
  it("sums the ledger inside an active window's interval only", () => {
    // 5h window resetting in 2h: interval opened 3h ago.
    const accounts = new Map([
      ["codex", reported([{ usedPct: 34, resetsAt: NOW + 2 * HOUR, windowMinutes: 300 }])],
    ]);
    const rows = providerWindowRows(
      accounts,
      [
        event({ occurredAt: NOW - HOUR, tokens: { input: 100 } }),
        event({
          occurredAt: NOW - 2 * HOUR,
          sessionId: "s2",
          rootSessionId: "s2",
          tokens: { output: 50 },
          costSource: "provider",
          costUsd: 0.5,
        }),
        event({ occurredAt: NOW - 4 * HOUR, tokens: { input: 9_999 } }), // before the window opened
        event({ agent: "claude", occurredAt: NOW - HOUR, tokens: { input: 7_777 } }), // other provider
      ],
      NOW,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("codex");
    expect(rows[0].expired).toBe(false);
    expect(rows[0].stale).toBe(false);
    expect(rows[0].ledger).toEqual({
      totalTokens: 150,
      providerCostUsd: 0.5,
      costEvents: 1,
      sessionCount: 2,
    });
  });

  // A long-passed reset once rendered a week of usage as a 5h window's own.
  it("marks an expired window and refuses its join", () => {
    const accounts = new Map([
      ["codex", reported([{ usedPct: 90, resetsAt: NOW - HOUR, windowMinutes: 300 }])],
    ]);
    const rows = providerWindowRows(
      accounts,
      [event({ occurredAt: NOW - 30 * 60_000 })],
      NOW,
    );
    expect(rows[0].expired).toBe(true);
    expect(rows[0].ledger).toBeNull();
  });

  it("flags a stale report but keeps the join while the window is alive", () => {
    // Report is 2h old, yet the weekly reset instant is still ahead: the
    // interval stays trustworthy, only the percentage deserves demotion.
    const accounts = new Map([
      [
        "codex",
        reported(
          [{ usedPct: 40, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 }],
          NOW - 2 * HOUR,
        ),
      ],
    ]);
    const rows = providerWindowRows(accounts, [event()], NOW);
    expect(rows[0].stale).toBe(true);
    expect(rows[0].expired).toBe(false);
    expect(rows[0].ledger?.totalTokens).toBe(100);
  });

  it("declines the join when the interval is unknowable or scoped", () => {
    const accounts = new Map([
      [
        "kimi",
        reported([
          { usedPct: 10, resetsAt: null, windowMinutes: 300 }, // no reset instant
          { usedPct: 20, resetsAt: NOW + HOUR, windowMinutes: null }, // no duration
          { usedPct: 30, resetsAt: null, windowMinutes: null, scope: "quota" },
        ]),
      ],
    ]);
    const rows = providerWindowRows(accounts, [event({ agent: "kimi" })], NOW);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.ledger)).toEqual([null, null, null]);
  });

  it("groups a provider's windows under one card identity", () => {
    const accounts = new Map<string, AccountUsage>([
      [
        "claude",
        reported(
          [
            { usedPct: 3, resetsAt: null, windowMinutes: 10_080 },
            { usedPct: 4, resetsAt: null, windowMinutes: 300 },
          ],
          NOW - 2 * HOUR,
        ),
      ],
      ["opencode", { kind: "unavailable", reason: "api-key", reportedAt: NOW }],
    ]);
    const groups = providerWindowGroups(accounts, [], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      agent: "claude",
      reportedAt: NOW - 2 * HOUR,
      stale: true,
    });
    expect(groups[0].rows.map((row) => row.window.windowMinutes)).toEqual([
      300, 10_080,
    ]);
  });

  it("mints distinct row ids even for windows sharing duration and scope", () => {
    // Codex's app-server can report several account windows with no stated
    // duration — identity must not collapse them.
    const accounts = new Map([
      [
        "codex",
        reported([
          { usedPct: 34, resetsAt: NOW + 2 * HOUR, windowMinutes: null },
          { usedPct: 71, resetsAt: NOW + 5 * HOUR, windowMinutes: null },
        ]),
      ],
    ]);
    const rows = providerWindowRows(accounts, [], NOW);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it("orders providers alphabetically, windows account-wide first then shortest", () => {
    const accounts = new Map<string, AccountUsage>([
      [
        "kimi",
        reported([
          { usedPct: 1, resetsAt: null, windowMinutes: null, scope: "quota" },
          { usedPct: 2, resetsAt: null, windowMinutes: 10_080 },
        ]),
      ],
      [
        "claude",
        reported([
          { usedPct: 3, resetsAt: null, windowMinutes: 10_080 },
          { usedPct: 4, resetsAt: null, windowMinutes: 300 },
        ]),
      ],
      ["opencode", { kind: "unavailable", reason: "api-key", reportedAt: NOW }],
    ]);
    const rows = providerWindowRows(accounts, [], NOW);
    expect(
      rows.map((row) => [row.agent, row.window.windowMinutes, row.window.scope]),
    ).toEqual([
      ["claude", 300, undefined],
      ["claude", 10_080, undefined],
      ["kimi", 10_080, undefined],
      ["kimi", null, "quota"],
    ]);
  });
});
