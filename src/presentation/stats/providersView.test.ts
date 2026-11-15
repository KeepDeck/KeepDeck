import { describe, expect, it } from "vitest";
import { formatAge, formatMoment, windowLabel, type AccountUsage, type UsageWindow } from "../../domain/usage";
import type { ProviderWindowGroup } from "../../domain/usage/providerWindows";
import type { WindowForecast } from "../../domain/usage/windowForecast";
import { providerWindowGroups } from "../../domain/usage/providerWindows";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { accountLimitsView, providersView } from "./providersView";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const COLORS = new Map([["claude", "#c1"]]);

const account = (windows: UsageWindow[], reportedAt = NOW - 60_000): AccountUsage => ({
  kind: "reported",
  windows,
  reportedAt,
  sourcePaneId: "",
});
const live = (usedPct: number, windowMinutes = 300): UsageWindow => ({
  usedPct,
  resetsAt: NOW + HOUR,
  windowMinutes,
});
const expired: UsageWindow = { usedPct: 40, resetsAt: NOW - HOUR, windowMinutes: 300 };
const DAY = 24 * HOUR;
/** A week window, by default with six days of it gone. */
const week = (usedPct: number, resetsAt = NOW + DAY): UsageWindow => ({ usedPct, resetsAt, windowMinutes: 10_080 });
const cardOf = (view: ReturnType<typeof providersView>) => {
  const card = view.kind === "cards" ? view.cards[0] : undefined;
  if (card === undefined) throw new Error("no card");
  return card;
};

const viewOf = (accounts: Map<string, AccountUsage>) =>
  providersView(providerWindowGroups(accounts, [], new Map(), NOW), NOW, COLORS);

describe("providersView", () => {
  it("says how the tab fills before any CLI reports its limits", () => {
    expect(viewOf(new Map())).toEqual({
      kind: "empty",
      text: "No provider reports yet. Windows appear once a CLI reports its account limits.",
    });
  });

  it("says once per card how long ago the account reported, amber once the report is stale", () => {
    const fresh = viewOf(new Map([["claude", account([live(10)])]]));
    const card = fresh.kind === "cards" ? fresh.cards[0] : undefined;
    expect(card?.updated).toEqual({ text: `Updated ${formatAge(NOW - 60_000, NOW)}` });
    expect(card?.age).toEqual({ text: formatAge(NOW - 60_000, NOW) });
    const stale = viewOf(new Map([["claude", account([live(10)], NOW - 2 * HOUR)]]));
    const staleCard = stale.kind === "cards" ? stale.cards[0] : undefined;
    expect(staleCard?.updated.className).toBe("usage-level--warn");
    expect(staleCard?.age).toEqual({ text: "2h ago", className: "usage-level--warn" });
  });

  it("gives each live window its own chart, the most pressing one on top", () => {
    const card = cardOf(viewOf(new Map([["claude", account([live(30), week(10)])]])));
    expect(card.windows.map((window) => window.label)).toEqual(["5h", "week"]);
    // Neither warns: the fuller one first, each on its own clock.
    expect(card.charted.map((entry) => [entry.window.label, entry.chart.ticks.length > 0])).toEqual([["5h", true], ["week", true]]);
    expect(card.others).toEqual([]);
    expect(card.color).toBe("#c1");
  });

  it("has nothing to chart when every window has reset — small tiles only", () => {
    const card = cardOf(viewOf(new Map([["claude", account([expired])]])));
    expect(card.charted).toEqual([]);
    expect(card.others).toHaveLength(1);
  });

  it("says when a window resets and its forecast on lines of their own; a reset one waits for its next report", () => {
    const [live5h, gone] = cardOf(viewOf(new Map([["claude", account([live(10), expired])]]))).windows;
    expect(live5h).toMatchObject({
      reset: `resets in 1h 0m · ${formatMoment(NOW + HOUR, NOW)}`,
      // No journal: no pace to say anything from.
      verdict: { text: "No forecast yet — too few recent reports" },
    });
    expect(gone).toMatchObject({ reset: "reset — waiting for its next report", verdict: null, expired: true });
  });

  it("colours a window's percentage near the limit, never a reset one", () => {
    const windows = cardOf(viewOf(new Map([["claude", account([week(85), expired])]]))).windows;
    expect(windows.find((window) => !window.expired)?.percent.className).toBe("usage-level--critical");
    expect(windows.find((window) => window.expired)?.percent.className).toBeUndefined();
  });

  it("charts a scoped week on its clock too, without this machine's unscoped usage", () => {
    const scoped: UsageWindow = { ...week(40), scope: "opus" };
    const card = cardOf(viewOf(new Map([["claude", account([live(10), scoped])]])));
    expect(card.charted.map((entry) => entry.window.label)).toEqual([windowLabel(scoped, "long"), "5h"]);
    expect(card.charted[0]?.chart.bars).toEqual([]);
  });

  it("puts the most urgent warning first: severity, then how soon, then how full", () => {
    const row = (agent: string, usedPct: number, forecast: WindowForecast): ProviderWindowGroup => ({
      agent,
      reportedAt: NOW,
      stale: false,
      idle: false,
      rows: [{ id: agent, agent, window: live(usedPct), reports: [], forecast, reportedAt: NOW, expired: false, stale: false, span: null, usage: null }],
    });
    const order = (groups: ProviderWindowGroup[]) => {
      const view = providersView(groups, NOW, COLORS);
      return view.kind === "cards" ? view.cards.map((card) => card.agent) : [];
    };
    const full = row("full", 90, { kind: "out", outAt: NOW + 2 * HOUR, level: "warn" });
    const urgent = row("urgent", 30, { kind: "out", outAt: NOW + 5 * 60_000, level: "critical" });
    const sooner = row("sooner", 20, { kind: "out", outAt: NOW + HOUR, level: "warn" });
    const calm = row("calm", 95, { kind: "idle" });
    expect(order([calm, full, sooner, urgent])).toEqual(["urgent", "sooner", "full", "calm"]);
  });

  it("puts a warning window above a fuller calm one inside a card", () => {
    const row = (id: string, window: UsageWindow, forecast: WindowForecast) => ({
      id, agent: "claude", window, reports: [], forecast, reportedAt: NOW, expired: false, stale: false,
      span: { from: (window.resetsAt ?? NOW) - (window.windowMinutes ?? 0) * 60_000, to: window.resetsAt ?? NOW },
      usage: null,
    });
    const group: ProviderWindowGroup = {
      agent: "claude", reportedAt: NOW, stale: false, idle: false,
      rows: [
        row("5h", live(20), { kind: "out", outAt: NOW + 30 * 60_000, level: "warn" }),
        row("week", week(60), { kind: "idle" }),
      ],
    };
    const view = providersView([group], NOW, COLORS);
    // The fuller week is calm; the 5h window runs out first, so it leads.
    expect(view.kind === "cards" ? view.cards[0]?.charted.map((entry) => entry.window.label) : []).toEqual(["5h", "week"]);
  });

  it("puts the provider with the fullest window first", () => {
    const view = viewOf(new Map([["claude", account([week(10)])], ["codex", account([week(80)])]]));
    expect(view.kind === "cards" ? view.cards.map((card) => card.agent) : []).toEqual(["codex", "claude"]);
  });

  it("says once what the bars under the charts count — tokens, the dialog's switch aside", () => {
    const accounts = new Map([["claude", account([week(10)])]]);
    const rows = [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 2 })];
    const view = accountLimitsView({ accounts, rows, reportsByKey: new Map(), now: NOW, colors: COLORS });
    expect(view.kind === "cards" ? view.note : undefined).toMatch(/^Bars are this machine's tokens less cache reads, by day/);
    expect(viewOf(new Map([["claude", account([expired])]]))).toMatchObject({ note: null });
  });

  it("is the one Limits pipeline both the Limits tab and Overview's glance read", () => {
    const accounts = new Map([["claude", account([live(10)])]]);
    const rows = [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 2 })];
    expect(accountLimitsView({ accounts, rows, reportsByKey: new Map(), now: NOW, colors: COLORS })).toEqual(
      providersView(providerWindowGroups(accounts, rows, new Map(), NOW), NOW, COLORS),
    );
  });
});
