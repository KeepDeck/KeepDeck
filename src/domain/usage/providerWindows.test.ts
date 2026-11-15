import { describe, expect, it } from "vitest";
import { providerWindowGroups, windowSpan, windowSteps } from "./providerWindows";
import { localDayNumber, localDayStart, localHourStart } from "./time";
import { inZone } from "./time.testSupport";

import { accountWindowKeys, type WindowReport } from "./reportJournal";
import type { AccountUsage, UsageWindow } from "./usage";

/** The production shape IS groups; tests reach rows through them — same
 * argument order as providerWindowGroups. Most cases exercise the usage
 * join and pass an empty journal. */
const flatRows = (
  accounts: Parameters<typeof providerWindowGroups>[0],
  events: Parameters<typeof providerWindowGroups>[1],
  byKey: Parameters<typeof providerWindowGroups>[2],
  now: number,
) => providerWindowGroups(accounts, events, byKey, now, "spend").flatMap((group) => group.rows);
const NO_JOURNAL = new Map<string, readonly WindowReport[]>();

import { TEST_NOW, usageEvent as event } from "./history/event.testSupport";
import { present } from "@keepdeck/plugin-api/testing";

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
  it("skips a reported account with zero windows — no headless card", () => {
    expect(
      providerWindowGroups(
        new Map([["codex", reported([])]]),
        [event()],
        new Map(),
        NOW,
        "spend",
      ),
    ).toEqual([]);
  });

  it("counts this machine's usage inside an active window's span only", () => {
    // 5h window resetting in 2h: its span opened 3h ago.
    const accounts = new Map([
      ["codex", reported([{ usedPct: 34, resetsAt: NOW + 2 * HOUR, windowMinutes: 300 }])],
    ]);
    const rows = flatRows(
      accounts,
      [
        event({ occurredAt: NOW - HOUR, tokens: { input: 100 } }),
        event({ occurredAt: NOW - 2 * HOUR, sessionId: "s2", rootSessionId: "s2", tokens: { output: 50 }, costUsd: 0.5 }),
        event({ occurredAt: NOW - 4 * HOUR, tokens: { input: 9_999 }, costUsd: 9 }), // before the window opened
        event({ agent: "claude", occurredAt: NOW - HOUR, tokens: { input: 7_777 }, costUsd: 7 }), // other provider
      ],
      NO_JOURNAL,
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("codex");
    expect(rows[0].expired).toBe(false);
    expect(rows[0].stale).toBe(false);
    expect(rows[0].span).toEqual({ from: NOW - 3 * HOUR, to: NOW + 2 * HOUR });
    const steps = rows[0].usage ?? [];
    expect(steps.reduce((sum, step) => sum + step.costUsd, 0)).toBe(0.5);
    expect(steps.reduce((sum, step) => sum + step.tokensLessCacheReads, 0)).toBe(150);
  });

  // A long-passed reset once rendered a week of usage as a 5h window's own.
  it("marks an expired window and refuses its join", () => {
    const accounts = new Map([
      ["codex", reported([{ usedPct: 90, resetsAt: NOW - HOUR, windowMinutes: 300 }])],
    ]);
    const rows = flatRows(
      accounts,
      [event({ occurredAt: NOW - 30 * 60_000 })],
      NO_JOURNAL,
      NOW,
    );
    expect(rows[0].expired).toBe(true);
    expect([rows[0].span, rows[0].usage]).toEqual([null, null]);
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
    const rows = flatRows(accounts, [event()], NO_JOURNAL, NOW);
    expect(rows[0].stale).toBe(true);
    expect(rows[0].expired).toBe(false);
    expect((rows[0].usage ?? []).reduce((sum, step) => sum + step.tokensLessCacheReads, 0)).toBe(100);
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
    const rows = flatRows(accounts, [event({ agent: "kimi" })], NO_JOURNAL, NOW);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.span, row.usage])).toEqual([[null, null], [null, null], [null, null]]);
  });

  it("steps this machine's usage through a week by calendar day, and a 5h window by the hour", () => {
    inZone("Asia/Nicosia", () => {
      // A week that began a day and a half ago, and a 5h window two hours in.
      const week: UsageWindow = { usedPct: 9, resetsAt: NOW + 5.5 * 24 * HOUR, windowMinutes: 10_080 };
      const fiveH: UsageWindow = { usedPct: 30, resetsAt: NOW + 3 * HOUR, windowMinutes: 300 };
      const accounts = new Map([["codex", reported([week, fiveH])]]);
      const events = [
        event({ occurredAt: NOW - 30 * 60_000, costUsd: 2 }),
        event({ occurredAt: NOW - 30 * HOUR, costUsd: 1 }),
        event({ occurredAt: NOW - 3 * 24 * HOUR, costUsd: 50 }), // before the week began
        event({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 70 }), // another provider
      ];
      const [short, long] = flatRows(accounts, events, NO_JOURNAL, NOW);
      const sum = (steps: { costUsd: number }[] | null | undefined) => (steps ?? []).reduce((total, step) => total + step.costUsd, 0);
      expect(long?.span).toEqual({ from: NOW - 1.5 * 24 * HOUR, to: week.resetsAt });
      expect(sum(long?.usage)).toBe(3);
      // Each step opens at a local midnight, the first one the day the week began, the last today.
      expect(long?.usage?.every((step) => step.start === localDayStart(localDayNumber(step.start)))).toBe(true);
      expect(long?.usage?.[0]?.start).toBe(localDayStart(localDayNumber(NOW - 1.5 * 24 * HOUR)));
      const steps = long?.usage ?? [];
      expect(steps[steps.length - 1]?.start).toBe(localDayStart(localDayNumber(NOW)));
      // The 5h window: only its own two hours, an hour a step.
      expect(sum(short?.usage)).toBe(2);
      expect(short?.usage?.map((step) => step.start)).toEqual([localHourStart(NOW - 2 * HOUR), localHourStart(NOW - HOUR), localHourStart(NOW)]);
    });
  });

  it("tells a window of two days or more by the day, a shorter one by the hour", () => {
    const span = (hours: number) => ({ from: NOW, to: NOW + hours * HOUR });
    expect([windowSteps(span(48)), windowSteps(span(47)), windowSteps(span(5))]).toEqual(["day", "hour", "hour"]);
    expect(windowSpan({ usedPct: 1, resetsAt: NOW + HOUR, windowMinutes: 300 }, NOW)).toEqual({ from: NOW - 4 * HOUR, to: NOW + HOUR });
  });

  it("carries the window's earlier instances from the journal", () => {
    const window: UsageWindow = { usedPct: 3, resetsAt: NOW + 4 * HOUR, windowMinutes: 300 };
    const accounts = new Map([["codex", reported([window])]]);
    const key = present(accountWindowKeys("codex", [window]).get(window), "the window's key").key;
    const previousReset = NOW - HOUR;
    const series: WindowReport[] = [
      { agent: "codex", windowMinutes: 300, usedPct: 40, reportedAt: previousReset - 2 * HOUR, resetsAt: previousReset },
      { agent: "codex", windowMinutes: 300, usedPct: 3, reportedAt: NOW, resetsAt: window.resetsAt },
    ];
    const [row] = flatRows(accounts, [], new Map([[key, series]]), NOW);
    expect(row?.earlier.map((e) => [e.resetsAt, e.peakPct])).toEqual([[previousReset, 40]]);
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
    const groups = providerWindowGroups(accounts, [], new Map(), NOW, "spend");
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

  it("carries each window's journal series and forecast from the join", () => {
    const window: UsageWindow = {
      usedPct: 88,
      resetsAt: NOW + 2 * HOUR,
      windowMinutes: 300,
    };
    const accounts = new Map([["codex", reported([window])]]);
    const key = present(accountWindowKeys("codex", [window]).get(window), "the window's key").key;
    const series: WindowReport[] = [
      { agent: "codex", windowMinutes: 300, usedPct: 58, reportedAt: NOW - 30 * 60_000, resetsAt: NOW + 2 * HOUR },
      { agent: "codex", windowMinutes: 300, usedPct: 88, reportedAt: NOW, resetsAt: NOW + 2 * HOUR },
    ];
    const rows = flatRows(accounts, [], new Map([[key, series]]), NOW);
    expect(rows[0].reports).toBe(series); // the join's series, not a re-derivation
    expect(rows[0].forecast.kind).toBe("out");
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
    const rows = flatRows(accounts, [], NO_JOURNAL, NOW);
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
    const rows = flatRows(accounts, [], NO_JOURNAL, NOW);
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
