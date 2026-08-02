import { describe, expect, it } from "vitest";
import { foldExhaustionAlerts, type ExhaustionAlerts } from "./exhaustionAlerts";
import { accountWindowKeys, type WindowReport } from "./reportJournal";
import type { AccountUsage, UsageWindow } from "./usage";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const MIN = 60_000;

const FIVE_H: UsageWindow = {
  usedPct: 88,
  resetsAt: NOW + 155 * MIN,
  windowMinutes: 300,
};

const report = (over: Partial<WindowReport> = {}): WindowReport => ({
  agent: "claude",
  windowMinutes: 300,
  usedPct: 10,
  reportedAt: NOW - 30 * MIN,
  resetsAt: NOW + 155 * MIN,
  ...over,
});

/** A steady ramp ending `endAgoMin` minutes before NOW at `lastPct`. */
const ramp = (
  pctPerMin: number,
  lastPct: number,
  endAgoMin = 0,
  over: Partial<WindowReport> = {},
): WindowReport[] =>
  Array.from({ length: 5 }, (_, index) => {
    const minutesAgo = endAgoMin + (4 - index) * 10;
    return report({
      reportedAt: NOW - minutesAgo * MIN,
      usedPct: lastPct - pctPerMin * (minutesAgo - endAgoMin),
      ...over,
    });
  });

const accountsOf = (
  windows: UsageWindow[],
  agent = "claude",
): Map<string, AccountUsage> =>
  new Map([
    [
      agent,
      { kind: "reported", windows, reportedAt: NOW - MIN, sourcePaneId: "p" },
    ],
  ]);

const keyOf = (windows: UsageWindow[], agent = "claude") =>
  accountWindowKeys(agent, windows).get(windows[0])!.key;

const seriesOf = (
  windows: UsageWindow[],
  reports: WindowReport[],
  agent = "claude",
) => new Map([[keyOf(windows, agent), reports]]);

// Verdict recipes (through the real forecast): 1%/min on 12% left → out in
// ~12m = critical; 0.29%/min → out in ~41m... beyond an hour? no: 12/0.29 ≈
// 41m — still critical. Warn needs out >1h away yet before the reset:
// 0.15%/min → 80m. Ok: 0.05%/min → 240m, past the 155m reset.
const CRITICAL = () => ramp(1, 88);
const WARN = () => ramp(0.15, 88);
const OK = () => ramp(0.05, 88);

describe("foldExhaustionAlerts", () => {
  const NONE: ExhaustionAlerts = new Map();

  it("fires on ENTERING critical and holds silent while it lasts", () => {
    const windows = [FIVE_H];
    const first = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    expect(first.notices).toHaveLength(1);
    const second = foldExhaustionAlerts(
      first.alerts,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    expect(second.notices).toHaveLength(0);
    // The instance anchor is the journal's: the segment's first report.
    expect(second.alerts.get(keyOf(windows))).toEqual({
      anchor: NOW - 40 * MIN,
    });
  });

  it("stays quiet on warn and ok verdicts", () => {
    const windows = [FIVE_H];
    for (const series of [WARN(), OK()]) {
      const { alerts, notices } = foldExhaustionAlerts(
        NONE,
        accountsOf(windows),
        seriesOf(windows, series),
        NOW,
      );
      expect(notices).toHaveLength(0);
      expect(alerts.size).toBe(0);
    }
  });

  it("holds a fired alarm through warn — de-escalation is not recovery", () => {
    const windows = [FIVE_H];
    const fired = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    const eased = foldExhaustionAlerts(
      fired.alerts,
      accountsOf(windows),
      seriesOf(windows, WARN()),
      NOW,
    );
    expect(eased.notices).toHaveLength(0);
    const reCritical = foldExhaustionAlerts(
      eased.alerts,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    expect(reCritical.notices).toHaveLength(0); // same instance — one alarm
  });

  it("re-arms on a real recovery to ok", () => {
    const windows = [FIVE_H];
    const fired = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    const recovered = foldExhaustionAlerts(
      fired.alerts,
      accountsOf(windows),
      seriesOf(windows, OK()),
      NOW,
    );
    expect(recovered.alerts.size).toBe(0);
    const again = foldExhaustionAlerts(
      recovered.alerts,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    expect(again.notices).toHaveLength(1);
  });

  it("never re-arms on unknown — a data gap is not a recovery", () => {
    const windows = [FIVE_H];
    const series = CRITICAL();
    const fired = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, series),
      NOW,
    );
    // 45 quiet minutes: the SAME journal, only the clock moved — the tail
    // is past the stale belt, so the forecast reads unknown.
    const later = NOW + 45 * MIN;
    const gap = foldExhaustionAlerts(
      fired.alerts,
      accountsOf(windows),
      seriesOf(windows, series),
      later,
    );
    expect(gap.notices).toHaveLength(0);
    expect(gap.alerts.get(keyOf(windows))).toEqual({ anchor: NOW - 40 * MIN });
    // Reports resume inside the same burning segment — the alarm holds.
    const resumed = [...series, report({ reportedAt: later, usedPct: 95 })];
    const back = foldExhaustionAlerts(
      gap.alerts,
      accountsOf(windows),
      seriesOf(windows, resumed),
      later,
    );
    expect(back.notices).toHaveLength(0); // still the same instance
  });

  it("re-fires when a NEW instance is already critical", () => {
    const windows = [FIVE_H];
    const fired = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    // The window reset: new anchor, and the fresh segment burns hot too.
    const nextWindow: UsageWindow = { ...FIVE_H, resetsAt: NOW + 300 * MIN };
    const nextSeries = [
      ...CRITICAL(),
      report({ reportedAt: NOW - 10 * MIN, usedPct: 70, resetsAt: NOW + 300 * MIN }),
      report({ reportedAt: NOW, usedPct: 88, resetsAt: NOW + 300 * MIN }),
    ];
    const next = foldExhaustionAlerts(
      fired.alerts,
      accountsOf([nextWindow]),
      seriesOf([nextWindow], nextSeries),
      NOW,
    );
    expect(next.notices).toHaveLength(1);
    // The anchor moved to the post-reset segment's first report.
    expect(next.alerts.get(keyOf([nextWindow]))).toEqual({
      anchor: NOW - 10 * MIN,
    });
  });

  it("re-arms after a top-up — a clockless plan window alarms again", () => {
    // kimi's quota has no reset clock: resetsAt stays null forever, so the
    // instance identity must come from the journal's segments, not the
    // reset anchor (which never moves).
    const quota: UsageWindow = {
      usedPct: 90,
      resetsAt: null,
      windowMinutes: null,
      scope: "quota",
    };
    const windows = [quota];
    const burn = [
      report({ windowMinutes: null, resetsAt: null, reportedAt: NOW - 30 * MIN, usedPct: 60 }),
      report({ windowMinutes: null, resetsAt: null, reportedAt: NOW, usedPct: 90 }),
    ];
    const fired = foldExhaustionAlerts(
      NONE,
      accountsOf(windows, "kimi"),
      seriesOf(windows, burn, "kimi"),
      NOW,
    );
    expect(fired.notices).toHaveLength(1);
    // Top-up: usage drops (a new segment), then the fresh allowance burns
    // hot again — a SECOND alarm is due.
    const later = NOW + 40 * MIN;
    const topped = [
      ...burn,
      report({ windowMinutes: null, resetsAt: null, reportedAt: NOW + 5 * MIN, usedPct: 10 }),
      report({ windowMinutes: null, resetsAt: null, reportedAt: later - 5 * MIN, usedPct: 40 }),
    ];
    const again = foldExhaustionAlerts(
      fired.alerts,
      accountsOf(windows, "kimi"),
      seriesOf(windows, topped, "kimi"),
      later,
    );
    expect(again.notices).toHaveLength(1);
  });

  it("holds through sub-jitter reset drift — the journal calls it one instance", () => {
    const windows = [FIVE_H];
    const fired = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    expect(fired.notices).toHaveLength(1);
    // The provider re-reports the same window with resetsAt drifted +30s —
    // inside currentSegment's 60s jitter belt, so the SAME segment.
    const drifted: UsageWindow = {
      ...FIVE_H,
      resetsAt: FIVE_H.resetsAt! + 30_000,
    };
    const later = NOW + MIN;
    const series = [
      ...CRITICAL(),
      report({ reportedAt: later, usedPct: 89, resetsAt: drifted.resetsAt }),
    ];
    const held = foldExhaustionAlerts(
      fired.alerts,
      accountsOf([drifted]),
      seriesOf([drifted], series),
      later,
    );
    expect(held.notices).toHaveLength(0);
  });

  it("ignores accounts that never reported and windows without series", () => {
    const { alerts, notices } = foldExhaustionAlerts(
      NONE,
      new Map<string, AccountUsage>([
        ["opencode", { kind: "unavailable", reason: "api-key", reportedAt: NOW }],
        [
          "claude",
          {
            kind: "reported",
            windows: [FIVE_H],
            reportedAt: NOW - MIN,
            sourcePaneId: "p",
          },
        ],
      ]),
      new Map(),
      NOW,
    );
    expect(notices).toHaveLength(0);
    expect(alerts.size).toBe(0);
  });

  it("alarms per window, agents isolated", () => {
    const claudeWindows = [FIVE_H];
    const codexWindows: UsageWindow[] = [
      { usedPct: 88, resetsAt: NOW + 155 * MIN, windowMinutes: 300 },
    ];
    const accounts = new Map<string, AccountUsage>([
      ...accountsOf(claudeWindows),
      ...accountsOf(codexWindows, "codex"),
    ]);
    const byKey = new Map([
      ...seriesOf(claudeWindows, CRITICAL()),
      ...seriesOf(codexWindows, OK().map((r) => ({ ...r, agent: "codex" })), "codex"),
    ]);
    const { notices } = foldExhaustionAlerts(NONE, accounts, byKey, NOW);
    expect(notices).toHaveLength(1);
    expect(notices[0].agent).toBe("claude");
  });

  it("phrases the notice from the popover's own captions", () => {
    const windows = [FIVE_H];
    const { notices } = foldExhaustionAlerts(
      NONE,
      accountsOf(windows),
      seriesOf(windows, CRITICAL()),
      NOW,
    );
    expect(notices[0].title).toBe("claude 5h window runs out in ~12m");
    expect(notices[0].body).toBe("resets in 2h 35m");
  });

  it("covers scoped plan windows with no reset clock", () => {
    const quota: UsageWindow = {
      usedPct: 90,
      resetsAt: null,
      windowMinutes: null,
      scope: "quota",
    };
    const windows = [quota];
    const series = [
      report({
        agent: "kimi",
        windowMinutes: null,
        resetsAt: null,
        reportedAt: NOW - 30 * MIN,
        usedPct: 60,
      }),
      report({
        agent: "kimi",
        windowMinutes: null,
        resetsAt: null,
        reportedAt: NOW,
        usedPct: 90,
      }),
    ];
    const { notices } = foldExhaustionAlerts(
      NONE,
      accountsOf(windows, "kimi"),
      seriesOf(windows, series, "kimi"),
      NOW,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("kimi quota window runs out in ~10m");
    expect(notices[0].body).toBe("plan allowance");
  });
});
