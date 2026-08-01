// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../../domain/usage/history";

const history = vi.hoisted(() => ({
  snapshot: { ready: true, events: [] as UsageEventV2[], error: null as string | null },
}));
vi.mock("../../app/useUsageHistorySnapshot", () => ({
  useUsageHistorySnapshot: () => history.snapshot,
}));

const usage = vi.hoisted(() => ({
  snapshot: { accounts: new Map(), panes: new Map() },
}));
vi.mock("../../app/useUsage", () => ({
  useUsage: () => usage.snapshot,
}));

import type { AccountUsage } from "../../domain/usage";
import { StatsDialog, UsageStats } from "./StatsDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const usageEvent = (over: Record<string, unknown> = {}): UsageEventV2 =>
  ({
  schemaVersion: 2,
  eventId: "event-1",
  occurredAt: NOW - 1_000,
  capturedAt: NOW,
  agent: "codex",
  model: "gpt-5.6-terra",
  workspaceId: "ws-1",
  workspaceName: "KeepDeck",
  workspaceCwd: "/repo",
  paneId: "pane-1",
  paneName: "auth-refactor",
  sessionId: "session-123456789",
  rootSessionId: "session-123456789",
  tokens: { input: 1_000, output: 100, cacheRead: 500 },
  costUsd: 0.25,
  costSource: "provider",
  observation: { tokens: { input: 1_000, output: 100, cacheRead: 500 } },
    ...over,
  }) as UsageEventV2;

describe("UsageStats", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    history.snapshot = { ready: true, events: [usageEvent()], error: null };
    usage.snapshot = { accounts: new Map(), panes: new Map() };
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const clickTab = (label: string) => {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === label,
    )!;
    act(() => tab.click());
  };

  it("renders as its own global dialog, not a settings section", () => {
    const close = vi.fn();
    act(() => root.render(createElement(StatsDialog, { onClose: close })));

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Usage statistics");
    expect(dialog.textContent).toContain("across every CLI and workspace");
    expect(dialog.closest(".modal-overlay")).not.toBeNull();
    expect(dialog.closest(".settings")).toBeNull();

    act(() => dialog.querySelector<HTMLButtonElement>(".ui-close")!.click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows period totals on Overview with model and session drill-down tabs", () => {
    act(() => root.render(createElement(UsageStats)));

    expect(host.textContent).toContain("1.6k");
    expect(host.textContent).toContain("≈$0.25");
    expect(host.textContent).toContain("API estimates");
    expect(host.querySelector('[aria-label="Daily tokens"]')).not.toBeNull();

    clickTab("Models");
    expect(host.textContent).toContain("gpt-5.6-terra");

    clickTab("Sessions");
    expect(host.textContent).toContain("auth-refactor");
    expect(host.textContent).toContain("KeepDeck · codex · session-…");
  });

  it("switches time ranges without remounting", () => {
    history.snapshot = {
      ready: true,
      events: [usageEvent({ occurredAt: NOW - 2 * 24 * 60 * 60 * 1_000 })],
      error: null,
    };
    act(() => root.render(createElement(UsageStats)));
    expect(host.textContent).toContain("gpt-5.6-terra"); // default 7d

    const day = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "24h",
    )!;
    act(() => day.click());
    expect(host.textContent).toContain("No usage recorded");
  });

  it("shows highlights with the prior-period delta and the busiest day", () => {
    history.snapshot = {
      ready: true,
      events: [
        usageEvent(),
        usageEvent({
          eventId: "prior",
          occurredAt: NOW - 8 * 24 * 60 * 60 * 1_000,
          tokens: { input: 800 },
        }),
      ],
      error: null,
    };
    act(() => root.render(createElement(UsageStats)));

    const recap = host.querySelector(".stats__recap")!;
    expect(recap.textContent).toContain("+100% vs prior 7d");
    expect(recap.textContent).toContain("top model gpt-5.6-terra (1.6k)");
    expect(recap.textContent).toContain("busiest day Jul 22 (1.6k)");
  });

  it("joins provider windows with ledger spend inside each window", () => {
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW - 60_000,
      sourcePaneId: "pane-1",
      windows: [
        { usedPct: 34, resetsAt: NOW + 2 * 3_600_000, windowMinutes: 300 },
        { usedPct: 51, resetsAt: null, windowMinutes: 10_080 },
      ],
    };
    usage.snapshot = { accounts: new Map([["codex", account]]), panes: new Map() };
    act(() => root.render(createElement(UsageStats)));
    clickTab("Providers");

    // One card per provider: the name and report age appear exactly once.
    const cards = host.querySelectorAll(".stats__provider");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.querySelector(".stats__provider-head")!.textContent).toBe(
      "codexupdated 1m ago",
    );
    expect(card.querySelectorAll(".stats__window")).toHaveLength(2);
    expect(card.textContent).toContain("5h");
    expect(card.textContent).toContain("34%");
    expect(card.textContent).toContain("resets in 2h 0m");
    expect(card.textContent).toContain("1.6k · 1 session · ≈$0.25 this window");
    // The weekly window has no reset instant: percentage without a join.
    expect(card.textContent).toContain("week");
    expect(card.textContent).toContain("51%");
    expect(card.textContent).toContain("reset unknown");
    // Both windows draw the shared popover fill bar.
    expect(card.querySelectorAll(".usage-bar")).toHaveLength(2);
  });

  it("shows the full achievements catalog: earned dated, locked with progress", () => {
    history.snapshot = {
      ready: true,
      events: [
        usageEvent({ tokens: { input: 2_000_000 } }),
      ],
      error: null,
    };
    act(() => root.render(createElement(UsageStats)));

    const gallery = host.querySelector(".stats__achievements")!;
    expect(gallery.querySelectorAll(".stats__achievement")).toHaveLength(11);
    expect(gallery.querySelectorAll(".stats__achievement--locked")).toHaveLength(10);

    const earned = gallery.querySelector(
      ".stats__achievement:not(.stats__achievement--locked)",
    )!;
    expect(earned.textContent).toContain("First Million");
    expect(earned.textContent).toContain("earned Jul 22, 2026");

    // Locked entries stay visible and show progress toward their threshold.
    expect(gallery.textContent).toContain("Picking Up Steam");
    expect(gallery.textContent).toContain("2M / 10M");
    expect(gallery.textContent).toContain("Trillionaire");
    expect(gallery.textContent).toContain("1 / 10");
  });

  it("disables the period switcher on the period-independent Providers tab", () => {
    act(() => root.render(createElement(UsageStats)));
    const periodButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>(".stats__period button")][0];
    expect(periodButton().disabled).toBe(false);

    clickTab("Providers");
    expect(periodButton().disabled).toBe(true);
    expect(host.querySelector(".stats__period--idle")).not.toBeNull();

    clickTab("Overview");
    expect(periodButton().disabled).toBe(false);
  });

  it("demotes expired and stale provider windows instead of joining them", () => {
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW - 2 * 3_600_000, // stale: 2h old
      sourcePaneId: "pane-1",
      windows: [
        { usedPct: 10, resetsAt: NOW - 3_600_000, windowMinutes: 300 }, // expired
        { usedPct: 81, resetsAt: NOW + 3 * 24 * 3_600_000, windowMinutes: 10_080 },
      ],
    };
    usage.snapshot = { accounts: new Map([["claude", account]]), panes: new Map() };
    history.snapshot = { ready: true, events: [usageEvent({ agent: "claude" })], error: null };
    act(() => root.render(createElement(UsageStats)));
    clickTab("Providers");

    const card = host.querySelector(".stats__provider")!;
    // The stale report age is announced once, in the card header.
    expect(card.querySelector(".stats__provider-head")!.textContent).toContain(
      "updated 2h ago",
    );
    const windows = [...card.querySelectorAll(".stats__window")];
    // Expired 5h window: no ledger numbers, an explicit reason, demoted look.
    expect(windows[0].textContent).toContain("reset passed");
    expect(windows[0].textContent).not.toContain("1.6k");
    expect(windows[0].className).toContain("stats__window--expired");
    // Live weekly window: joined despite the stale report.
    expect(windows[1].textContent).toContain("1.6k");
    expect(windows[1].className).not.toContain("stats__window--expired");
  });

  it("labels a live window with zero ledger activity honestly", () => {
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW - 60_000,
      sourcePaneId: "pane-1",
      windows: [{ usedPct: 0, resetsAt: NOW + 3 * 24 * 3_600_000, windowMinutes: 10_080 }],
    };
    usage.snapshot = { accounts: new Map([["kimi", account]]), panes: new Map() };
    act(() => root.render(createElement(UsageStats)));
    clickTab("Providers");

    const providers = host.querySelector('[aria-label="Providers"]')!;
    expect(providers.textContent).toContain("no usage this window");
    expect(providers.textContent).not.toContain("0 sessions");
  });

  it("reaches arbitrarily old events through the All period", () => {
    history.snapshot = {
      ready: true,
      events: [usageEvent({ occurredAt: NOW - 400 * 24 * 60 * 60 * 1_000 })],
      error: null,
    };
    act(() => root.render(createElement(UsageStats)));
    expect(host.textContent).toContain("No usage recorded"); // default 7d

    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "All",
    )!;
    act(() => all.click());
    expect(host.textContent).toContain("gpt-5.6-terra");
  });

  it("does not render unknown cost as a fake zero", () => {
    history.snapshot = {
      ready: true,
      events: [usageEvent({ costUsd: undefined, costSource: "unavailable" })],
      error: null,
    };
    act(() => root.render(createElement(UsageStats)));

    expect(host.textContent).toContain("No CLI reported a cost estimate");
    const costCard = [...host.querySelectorAll(".stats__card")].find((card) =>
      card.textContent?.startsWith("Cost"),
    )!;
    expect(costCard.textContent).toBe("Cost—");

    clickTab("Sessions");
    const session = host.querySelector('[aria-label="Sessions"]')!;
    expect(session.textContent).toContain("—");
  });
});
