import { describe, expect, it } from "vitest";
import { usageAchievementLadders } from "../../domain/usage/achievements/ladders";
import { usageEvent, type UsageRowOverrides } from "../../domain/usage/history/event.testSupport";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { NO_TEAM_HISTORY } from "../../domain/usage/stats/teams";
import { inZone } from "../../domain/usage/time.testSupport";
import { CALENDAR_WEEKS, weeklyDigestView, weeklyView } from "./weeklyView";

const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-11-11T21:00:00+02:00"); // Wednesday
const MONDAY = at("2026-11-09T10:00:00+02:00");
const LAST_MONDAY = at("2026-11-02T10:00:00+02:00");

/** The week `back` weeks before this one, by the instant it starts. */
const weekOf = (back: number) => (back === 0 ? null : at(back === 1 ? "2026-11-02T00:00:00+02:00" : "2026-10-26T00:00:00+02:00"));

function view(rows: UsageRowOverrides[], { back = 0, reports = new Map<string, WindowReport[]>() } = {}) {
  let result: ReturnType<typeof weeklyView> | undefined;
  inZone("Asia/Nicosia", () => {
    const events = rows.map((row) => usageEvent(row));
    result = weeklyView(events, { now: NOW, week: weekOf(back), teams: NO_TEAM_HISTORY, reports, ladders: usageAchievementLadders(events) });
  });
  if (result === undefined) throw new Error("no view");
  return result;
}

describe("the Weekly report", () => {
  it("reports this week so far against last week at the same point", () => {
    const shown = view([
      { occurredAt: MONDAY, costUsd: 50 },
      { occurredAt: LAST_MONDAY, costUsd: 100 },
      // Last week, but past this week's point (Wednesday 21:00): not compared.
      { occurredAt: at("2026-11-06T10:00:00+02:00"), costUsd: 900 },
    ]);
    expect(shown.nav).toMatchObject({ label: "This week · Nov 9 – today", newer: null, older: { week: weekOf(1) } });
    expect(shown.spent).toEqual({ label: "Spent this week", value: "≈$50.00", change: { text: "↓ 50%", tone: "good" }, caption: "vs last week at this point" });
  });

  it("reports a past week whole, and pages within the ledger", () => {
    const shown = view([{ occurredAt: LAST_MONDAY, costUsd: 10 }, { occurredAt: MONDAY, costUsd: 1 }], { back: 1 });
    // Forward from last week is this week, which follows the calendar.
    expect(shown.nav).toMatchObject({ label: "Nov 2 – Nov 8", newer: { week: null }, older: null });
    expect(shown.spent).toMatchObject({ label: "Spent that week", value: "≈$10.00", change: null, caption: "no comparable week before" });
    // Badge progress is about now — a past week does not show it.
    expect(shown.badges).toBeNull();
  });

  it("says in plain sentences what the money went on", () => {
    const shown = view([
      { occurredAt: MONDAY, model: "anthropic/claude-opus-5-5", modelName: "Claude Opus 5.5", costUsd: 3, savedUsd: 25, tokens: { output: 2_000_000 } },
      { occurredAt: MONDAY, sessionId: "s2", model: "zai/glm-5.3", modelName: "GLM-5.3", costUsd: 1 },
    ]);
    expect(shown.lines).toEqual([
      "Claude Opus 5.5 ran 75% of the spend; output was 2M tokens, reasoning included.",
      "Cache reads cost ≈$25.00 less than the same tokens as fresh input would have, at list price.",
      "2 sessions with usage; the costliest day was Mon, Nov 9, 2026 (≈$4.00).",
    ]);
  });

  it("names the costliest day only once a price says which, and no saving when there is none", () => {
    const shown = view([{ occurredAt: MONDAY, tokens: { input: 5 } }]);
    expect(shown.lines).toEqual(["1 session with usage."]);
  });

  it("lays out the recent weeks a day per square, the reported week marked", () => {
    const shown = view([{ occurredAt: MONDAY, costUsd: 4 }, { occurredAt: LAST_MONDAY, costUsd: 1 }], { back: 1 });
    expect(shown.calendar.weeks).toHaveLength(CALENDAR_WEEKS);
    const last = shown.calendar.weeks[CALENDAR_WEEKS - 1];
    const before = shown.calendar.weeks[CALENDAR_WEEKS - 2];
    expect(last?.days.map((day) => day.level)).toEqual([4, 0, 0]);
    expect(before?.days[0]).toMatchObject({ level: 1, selected: true });
    expect(last?.days[0]?.selected).toBe(false);
  });

  it("shows the week's rhythm, a sliver for any money and nothing for none", () => {
    const shown = view([{ occurredAt: MONDAY, costUsd: 100 }, { occurredAt: at("2026-11-10T14:00:00+02:00"), costUsd: 0.5 }]);
    const [days, hours] = shown.rhythm;
    expect(days?.bars.map((bar) => bar.height)).toEqual([1, 0.02, 0, 0, 0, 0, 0]);
    expect(days?.labelled).toBe(true);
    expect(hours?.bars).toHaveLength(24);
    expect(hours?.labelled).toBe(false);
  });

  it("gives the fullest limit readings, and says when a past week's are gone", () => {
    const report = (usedPct: number, reportedAt: number): WindowReport => ({ agent: "claude", windowMinutes: 10_080, usedPct, reportedAt, resetsAt: null });
    const reports = new Map([["k", [report(40, MONDAY), report(97, MONDAY + 1)]]]);
    expect(view([{ occurredAt: MONDAY, costUsd: 1 }], { reports }).peaks.rows).toEqual([{ key: "k", label: "claude week", pct: "97%" }]);
    expect(view([{ occurredAt: LAST_MONDAY, costUsd: 1 }], { back: 1 }).peaks.empty).toBe("Readings for this week are no longer kept.");
    expect(view([{ occurredAt: MONDAY, costUsd: 1 }]).peaks.empty).toBe("No limit readings yet this week.");
  });

  it("puts the badges nearest to falling first, this week only", () => {
    const badges = view([{ occurredAt: MONDAY, costUsd: 1 }]).badges;
    expect(badges?.title).toBe("Closest to the next badge");
    expect(badges?.rows.length).toBeGreaterThan(0);
    const shares = badges?.rows.map((row) => parseInt(row.pct, 10)) ?? [];
    expect(shares).toEqual([...shares].sort((left, right) => right - left));
  });
});

describe("the weekly digest", () => {
  it("tells last week's report in the tab's own words, and opens on that week", () => {
    inZone("Asia/Nicosia", () => {
      const rows = [
        usageEvent({ occurredAt: LAST_MONDAY, model: "a/m", modelName: "Model M", costUsd: 80 }),
        usageEvent({ occurredAt: at("2026-10-27T10:00:00+02:00"), costUsd: 100 }),
      ];
      expect(weeklyDigestView(rows, NOW)).toEqual({
        week: at("2026-11-02T00:00:00+02:00"),
        title: "Your week in KeepDeck · Nov 2 – Nov 8",
        body: "≈$80.00 spent (↓ 20% vs the week before). Model M ran 100% of the spend; output was 0 tokens, reasoning included.",
      });
    });
  });

  it("has nothing to tell for a week with no usage", () => {
    inZone("Asia/Nicosia", () => {
      expect(weeklyDigestView([usageEvent({ occurredAt: MONDAY, costUsd: 1 })], NOW)).toBeNull();
    });
  });
});
