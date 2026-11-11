import { describe, expect, it } from "vitest";
import { formatAge, type AccountUsage, type UsageWindow } from "../../domain/usage";
import { providerWindowGroups } from "../../domain/usage/providerWindows";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { providersView } from "./providersView";

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
    const stale = viewOf(new Map([["claude", account([live(10)], NOW - 2 * HOUR)]]));
    expect(stale.kind === "cards" ? stale.cards[0]?.updated.className : undefined).toBe("usage-level--warn");
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
      providerWindowGroups(new Map([["claude", account([live(10)])]]), events, new Map(), NOW),
      NOW,
      COLORS,
    );
    const window = view.kind === "cards" ? view.cards[0]?.windows[0] : undefined;
    expect(window?.sessions).toEqual([
      { key: "claude\u0000s1", name: "auth", source: "KeepDeck · claude", cost: "≈$2.00" },
      { key: "claude\u0000s2", name: "docs", source: "Docs · claude", cost: "—" },
    ]);
  });
});
