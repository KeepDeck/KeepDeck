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
  providersView(providerWindowGroups(accounts, [], new Map(), NOW, "spend"), NOW, COLORS, "spend");

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

  it("draws a card around its longest live window, the shorter one marked where it runs", () => {
    const card = cardOf(viewOf(new Map([["claude", account([live(30), week(10)])]])));
    expect(card.windows.map((window) => window.label)).toEqual(["5h", "week"]);
    expect(card.lead?.label).toBe("week");
    expect(card.others.map((window) => window.label)).toEqual(["5h"]);
    expect(card.color).toBe("#c1");
    expect(card.chart?.slices).toEqual([expect.objectContaining({ label: expect.stringMatching(/^5h window · \d\d:\d\d–\d\d:\d\d$/) })]);
  });

  it("has no window to draw a card around when every one has reset", () => {
    const card = cardOf(viewOf(new Map([["claude", account([expired])]])));
    expect([card.lead, card.chart]).toEqual([null, null]);
    expect(card.others).toHaveLength(1);
  });

  it("says when a window resets and its forecast on lines of their own; a reset one waits for its next report", () => {
    const [live5h, gone] = cardOf(viewOf(new Map([["claude", account([live(10), expired])]]))).windows;
    expect(live5h).toMatchObject({
      reset: `resets in 1h 0m · ${formatMoment(NOW + HOUR, NOW)}`,
      // No journal: no pace to say anything from.
      verdict: { text: "No forecast yet — too few recent reports" },
      // Four of its five hours have gone.
      pace: { left: "80.0%", title: "80% of the window's time has gone" },
    });
    expect(gone).toMatchObject({ reset: "reset — waiting for its next report", verdict: null, pace: null, expired: true });
  });

  it("colours a window's percentage near the limit, never a reset one", () => {
    const windows = cardOf(viewOf(new Map([["claude", account([week(85), expired])]]))).windows;
    expect(windows.find((window) => !window.expired)?.percent.className).toBe("usage-level--critical");
    expect(windows.find((window) => window.expired)?.percent.className).toBeUndefined();
  });

  it("lets a scoped week lead over an unscoped 5h window", () => {
    const scoped: UsageWindow = { ...week(40), scope: "opus" };
    const card = cardOf(viewOf(new Map([["claude", account([live(10), scoped])]])));
    expect(card.lead?.label).toBe(windowLabel(scoped, "long"));
    expect(card.chart?.bars).toEqual([]);
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
      const view = providersView(groups, NOW, COLORS, "spend");
      return view.kind === "cards" ? view.cards.map((card) => card.agent) : [];
    };
    const full = row("full", 90, { kind: "out", outAt: NOW + 2 * HOUR, level: "warn" });
    const urgent = row("urgent", 30, { kind: "out", outAt: NOW + 5 * 60_000, level: "critical" });
    const sooner = row("sooner", 20, { kind: "out", outAt: NOW + HOUR, level: "warn" });
    const calm = row("calm", 95, { kind: "idle" });
    expect(order([calm, full, sooner, urgent])).toEqual(["urgent", "sooner", "full", "calm"]);
  });

  it("puts the provider with the fullest window first", () => {
    const view = viewOf(new Map([["claude", account([week(10)])], ["codex", account([week(80)])]]));
    expect(view.kind === "cards" ? view.cards.map((card) => card.agent) : []).toEqual(["codex", "claude"]);
  });

  it("says once what the bars under the charts count, in the reader's measure", () => {
    const accounts = new Map([["claude", account([week(10)])]]);
    const rows = [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 2 })];
    const note = (measure: "spend" | "tokens") => {
      const view = accountLimitsView({ accounts, rows, reportsByKey: new Map(), now: NOW, colors: COLORS, measure });
      return view.kind === "cards" ? view.note : undefined;
    };
    expect(note("spend")).toMatch(/^Bars are this machine's spend at list price, by day/);
    expect(note("tokens")).toMatch(/^Bars are this machine's tokens less cache reads, by day/);
    expect(viewOf(new Map([["claude", account([expired])]]))).toMatchObject({ note: null });
    // Usage no price covers is said, never drawn as none.
    const unpriced = accountLimitsView({
      accounts,
      rows: [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: undefined, tokens: { input: 9 } })],
      reportsByKey: new Map(),
      now: NOW,
      colors: COLORS,
      measure: "spend",
    });
    expect(unpriced.kind === "cards" ? unpriced.note : null).toMatch(/a hollow one has none priced\.$/);
  });

  it("is the one Limits pipeline both the Limits tab and Overview's glance read", () => {
    const accounts = new Map([["claude", account([live(10)])]]);
    const rows = [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 2 })];
    expect(accountLimitsView({ accounts, rows, reportsByKey: new Map(), now: NOW, colors: COLORS, measure: "spend" })).toEqual(
      providersView(providerWindowGroups(accounts, rows, new Map(), NOW, "spend"), NOW, COLORS, "spend"),
    );
  });
});
