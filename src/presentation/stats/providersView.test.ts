import { describe, expect, it } from "vitest";
import { formatAge, formatMoment, type AccountUsage, type UsageWindow } from "../../domain/usage";
import { accountWindowKeys } from "../../domain/usage/reportJournal";
import { present } from "@keepdeck/plugin-api/testing";
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
    expect(card.windows.find((window) => window.id === card.main)?.label).toBe("week");
    expect(card.color).toBe("#c1");
    expect(card.chart?.slices).toEqual([expect.objectContaining({ label: expect.stringMatching(/^5h window · \d\d:\d\d–\d\d:\d\d$/) })]);
  });

  it("has no window to draw a card around when every one has reset", () => {
    const card = cardOf(viewOf(new Map([["claude", account([expired])]])));
    expect([card.main, card.chart]).toEqual([null, null]);
  });

  it("says when a window resets and its forecast on lines of their own; a reset one waits for its next report", () => {
    const [live5h, gone] = cardOf(viewOf(new Map([["claude", account([live(10), expired])]]))).windows;
    expect(live5h).toMatchObject({
      reset: `resets in 1h 0m · ${formatMoment(NOW + HOUR, NOW)}`,
      // No journal: no pace to say anything from.
      verdict: { text: "Not enough data yet" },
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

  it("says where the last window stood at this point of its own, while the journal reaches back that far", () => {
    const current = week(3, NOW + 6 * DAY);
    const key = present(accountWindowKeys("claude", [current]).get(current), "the week's key").key;
    const previousReset = NOW - DAY;
    const journal = [
      { agent: "claude", windowMinutes: 10_080, usedPct: 1, reportedAt: previousReset - 7 * DAY + HOUR, resetsAt: previousReset },
      { agent: "claude", windowMinutes: 10_080, usedPct: 14, reportedAt: previousReset - 6 * DAY - HOUR, resetsAt: previousReset },
      { agent: "claude", windowMinutes: 10_080, usedPct: 56, reportedAt: previousReset - DAY, resetsAt: previousReset },
    ];
    const view = providersView(providerWindowGroups(new Map([["claude", account([current])]]), [], new Map([[key, journal]]), NOW, "spend"), NOW, COLORS, "spend");
    const card = cardOf(view);
    expect(card.windows[0]?.earlier).toBe("last window at this point: 14%");
    expect(card.chart?.earlier.map((window) => window.label)).toEqual([expect.stringMatching(/^56% · /)]);
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
  });

  it("is the one Limits pipeline both the Limits tab and Overview's glance read", () => {
    const accounts = new Map([["claude", account([live(10)])]]);
    const rows = [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 2 })];
    expect(accountLimitsView({ accounts, rows, reportsByKey: new Map(), now: NOW, colors: COLORS, measure: "spend" })).toEqual(
      providersView(providerWindowGroups(accounts, rows, new Map(), NOW, "spend"), NOW, COLORS, "spend"),
    );
  });
});
