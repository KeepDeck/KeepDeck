import { describe, expect, it } from "vitest";
import { formatAge, type AccountUsage, type UsageWindow } from "../../domain/usage";
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

  it("notes a reset window whenever ANY window has reset, not only all of them", () => {
    const some = viewOf(new Map([["claude", account([live(10, 10_080), expired])]]));
    expect(some.kind === "cards" ? some.cards[0]?.note : null).toMatch(/^A window that has reset keeps showing/);
    const none = viewOf(new Map([["claude", account([live(10)])]]));
    expect(none.kind === "cards" ? none.cards[0]?.note : undefined).toBeNull();
  });

  it("colours a window's percentage near the limit and marks a reset window", () => {
    const view = viewOf(new Map([["claude", account([live(85, 10_080), expired])]]));
    const windows = view.kind === "cards" ? (view.cards[0]?.windows ?? []) : [];
    const hot = windows.find((window) => !window.expired);
    const gone = windows.find((window) => window.expired);
    expect(hot?.percent.className).toBe("usage-level--critical");
    expect(hot?.stroke).toBe("#c1");
    expect(gone?.percent.className).toBeUndefined();
  });

  it("joins the caption's parts with a separator after the first", () => {
    const view = viewOf(new Map([["claude", account([live(10)])]]));
    const caption = view.kind === "cards" ? (view.cards[0]?.windows[0]?.caption ?? []) : [];
    expect(caption.length).toBeGreaterThan(0);
    expect(caption.map((part) => part.lead)).toEqual(caption.map((_, index) => (index === 0 ? "" : " · ")));
  });

  it("names the sessions that spent inside a window, with their money", () => {
    const events = [
      usageEvent({ agent: "claude", occurredAt: NOW - HOUR, paneName: "auth", workspaceName: "KeepDeck", costUsd: 2 }),
      usageEvent({ agent: "claude", occurredAt: NOW - HOUR, sessionId: "s2", paneName: "docs", workspaceName: "Docs" }),
    ];
    const view = providersView(
      providerWindowGroups(new Map([["claude", account([live(10)])]]), events, new Map(), NOW, "spend"),
      NOW,
      COLORS,
      "spend",
    );
    const window = view.kind === "cards" ? view.cards[0]?.windows[0] : undefined;
    expect(window?.sessions).toEqual([
      { key: "claude\u0000s1", name: "auth", source: "KeepDeck · claude", amount: "≈$2.00" },
      { key: "claude\u0000s2", name: "docs", source: "Docs · claude", amount: "—" },
    ]);
  });

  it("names a window's sessions and its line in tokens when the reader counts them", () => {
    const events = [
      usageEvent({ agent: "claude", occurredAt: NOW - HOUR, paneName: "auth", workspaceName: "KeepDeck", costUsd: 2, tokens: { input: 50 } }),
      usageEvent({ agent: "claude", occurredAt: NOW - HOUR, sessionId: "s2", paneName: "docs", workspaceName: "Docs", tokens: { input: 700 } }),
    ];
    const view = accountLimitsView({ accounts: new Map([["claude", account([live(10)])]]), rows: events, reportsByKey: new Map(), now: NOW, colors: COLORS, measure: "tokens" });
    const window = view.kind === "cards" ? view.cards[0]?.windows[0] : undefined;
    expect(window?.ledger).toBe("750 tokens · 2 sessions this window");
    // The one with no price did the most work — first.
    expect(window?.sessions.map((session) => [session.name, session.amount])).toEqual([["docs", "700"], ["auth", "50"]]);
  });

  it("is the one Limits pipeline both the Limits tab and Overview's glance read", () => {
    const accounts = new Map([["claude", account([live(10)])]]);
    const rows = [usageEvent({ agent: "claude", occurredAt: NOW - HOUR, costUsd: 2 })];
    expect(accountLimitsView({ accounts, rows, reportsByKey: new Map(), now: NOW, colors: COLORS, measure: "spend" })).toEqual(
      providersView(providerWindowGroups(accounts, rows, new Map(), NOW, "spend"), NOW, COLORS, "spend"),
    );
  });
});
