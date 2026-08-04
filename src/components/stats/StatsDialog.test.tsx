// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../../domain/usage/history/event";

const history = vi.hoisted(() => ({
  snapshot: {
    ready: true,
    events: [] as UsageEventV2[],
    error: null as string | null,
    complete: true,
  },
}));

/** A ready snapshot of the whole ledger — the healthy case these cases mean
 * whenever they do not say otherwise. */
const ledger = (events: UsageEventV2[]) => ({
  ready: true,
  events,
  error: null as string | null,
  complete: true,
});
vi.mock("../../app/useUsageHistorySnapshot", () => ({
  useUsageHistorySnapshot: () => history.snapshot,
}));

const usage = vi.hoisted(() => ({
  snapshot: { accounts: new Map(), panes: new Map() },
}));
vi.mock("../../app/useUsage", () => ({
  useUsage: () => usage.snapshot,
}));

const windowReports = vi.hoisted(() => ({
  snapshot: { ready: true, byKey: new Map() } as {
    ready: boolean;
    byKey: Map<string, unknown>;
  },
}));
vi.mock("../../app/useWindowReports", () => ({
  useWindowReports: () => windowReports.snapshot,
}));

import type { AccountUsage } from "../../domain/usage";
import {
  TEST_NOW,
  usageEvent as baseEvent,
} from "../../domain/usage/history/event.testSupport";
import { StatsDialog, UsageStats } from "./StatsDialog";
import type { StatsTab } from "../../domain/usage/statsTabs";

/** The dialog's tab is controlled by the app-layer owner; tests host that
 * ownership in a tiny stateful wrapper. */
function Host({ initialTab = "overview" }: { initialTab?: StatsTab }) {
  const [tab, setTab] = useState<StatsTab>(initialTab);
  return createElement(UsageStats, { tab, onSelectTab: setTab });
}

function DialogHost({ onClose = () => {} }: { onClose?: () => void }) {
  const [tab, setTab] = useState<StatsTab>("overview");
  return createElement(StatsDialog, { tab, onSelectTab: setTab, onClose });
}

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = TEST_NOW;
/** This file's personality over the shared builder: a costed codex session
 * with a human pane name — the dialog's cost cells and identity columns
 * assert on these, so the divergence is EXPLICIT here, not baked into a
 * private copy of the whole shape. */
const usageEvent = (over: Record<string, unknown> = {}): UsageEventV2 =>
  baseEvent({
    capturedAt: NOW,
    paneName: "auth-refactor",
    sessionId: "session-123456789",
    rootSessionId: "session-123456789",
    tokens: { input: 1_000, output: 100, cacheRead: 500 },
    observation: { tokens: { input: 1_000, output: 100, cacheRead: 500 } },
    costUsd: 0.25,
    costSource: "provider",
    ...over,
  });

/** The shell: the stats dialog routes a tab or period choice to the panel
 * that answers it, and keeps the shared clock and the ledger's failure
 * honest across that boundary.
 *
 * What a panel then renders belongs to the panel's own suite, and every one
 * of them now has one — Overview, StatsTable, Providers, Achievements,
 * Weeks, StreakBadge — each mounted directly, with no tab to click first.
 * A case that reads a number out of a panel's markup is in the wrong file:
 * the boundary only holds while nothing crosses it. */
describe("UsageStats", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    history.snapshot = ledger([usageEvent()]);
    usage.snapshot = { accounts: new Map(), panes: new Map() };
    windowReports.snapshot = { ready: true, byKey: new Map() };
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

  it("renders as its own global dialog, not a settings section", async () => {
    const close = vi.fn();
    // First render in the file: the lazy chart chunk resolves HERE, inside
    // an async act, so the Suspense re-render is adopted instead of firing
    // React's suspended-resource act warning in whichever later test the
    // event loop happens to land it.
    await act(async () => {
      root.render(createElement(DialogHost, { onClose: close }));
      await import("./UsageChart");
    });

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Statistics");
    expect(dialog.textContent).toContain("across every CLI and workspace");
    expect(dialog.closest(".modal-overlay")).not.toBeNull();
    expect(dialog.closest(".settings")).toBeNull();

    act(() => dialog.querySelector<HTMLButtonElement>(".ui-close")!.click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows period totals on Overview with model and session drill-down tabs", async () => {
    act(() => root.render(createElement(Host)));

    expect(host.textContent).toContain("1.6k");
    expect(host.textContent).toContain("≈$0.25");
    expect(host.textContent).toContain("API estimates");
    // The chart rides a lazy chunk — poll until the import lands. Each
    // poll flushes the pending chunk resolution INSIDE act() (an empty
    // async act adopts the Suspense re-render), then asserts on settled
    // DOM: asserting alone trips React's act warnings on every run, and
    // asserting inside one big act() never sees the flush at all.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.querySelector('[aria-label="Daily tokens"]')).not.toBeNull();
    });

    clickTab("Models");
    expect(host.textContent).toContain("gpt-5.6-terra");

    clickTab("Sessions");
    expect(host.textContent).toContain("auth-refactor");
    expect(host.textContent).toContain("KeepDeck · codex · session-…");
  });

  it("shows a just-appended event immediately, not after the next clock tick", () => {
    act(() => root.render(createElement(Host)));
    expect(host.textContent).toContain("1.6k");

    // An agent finishes a turn seconds AFTER the dialog's slow clock last
    // ticked: the appended event's instant is ahead of that clock, and the
    // `occurredAt <= now` filter must not hide it for up to 30s.
    history.snapshot = ledger([
      usageEvent(),
      usageEvent({
        occurredAt: NOW + 5_000,
        capturedAt: NOW + 5_000,
        tokens: { input: 100_000 },
        observation: { tokens: { input: 100_000 } },
      }),
    ]);
    act(() => root.render(createElement(Host)));
    expect(host.textContent).toContain("101.6k");
  });

  it("switches time ranges without remounting", () => {
    history.snapshot = {
      ...ledger([usageEvent({ occurredAt: NOW - 2 * 24 * 60 * 60 * 1_000 })]),
    };
    act(() => root.render(createElement(Host)));
    expect(host.textContent).toContain("gpt-5.6-terra"); // default 7d

    const day = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "24h",
    )!;
    act(() => day.click());
    // The period went empty, but Overview STAYS: zeroed cards over an
    // intact Weeks history — an empty period must never hide the one
    // period-independent block (review finding).
    expect(host.querySelectorAll(".stats__card b")[0].textContent).toBe("0");
    expect(host.querySelector(".stats__weeks")).not.toBeNull();
  });

  it("keeps Providers alive when the ledger failed to load", () => {
    history.snapshot = {
      ready: true,
      events: [],
      error: "ledger read failed",
      complete: false,
    };
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW - 60_000,
      sourcePaneId: "pane-1",
      windows: [{ usedPct: 34, resetsAt: NOW + 2 * 3_600_000, windowMinutes: 300 }],
    };
    usage.snapshot = { accounts: new Map([["codex", account]]), panes: new Map() };
    act(() => root.render(createElement(Host)));

    // Ledger-backed tabs surface the failure…
    expect(host.textContent).toContain("Usage history is unavailable");
    clickTab("Providers");
    // …but Providers reads the independent account snapshot and renders.
    expect(host.querySelector(".stats__provider")).not.toBeNull();
    expect(host.textContent).toContain("34%");
    expect(host.textContent).not.toContain("Usage history is unavailable");
  });

  it("seats the streak chip in the footer, outside the tab body", () => {
    // WHERE it sits is the dialog's decision — the chip reads the ledger
    // itself precisely so it can live outside the tabs. What it then says
    // is its own suite's business (StreakBadge.test.tsx).
    const DAY = 24 * 60 * 60 * 1_000;
    history.snapshot = {
      ...ledger(
        [0, 1, 2, 3].map((daysAgo) =>
          usageEvent({ eventId: `d-${daysAgo}`, occurredAt: NOW - daysAgo * DAY }),
        ),
      ),
    };
    act(() => root.render(createElement(DialogHost, { onClose: vi.fn() })));

    const footer = document.body.querySelector(".stats-dialog__actions")!;
    expect(footer.querySelector(".stats__streak")).not.toBeNull();
    expect(
      document.body.querySelector(".stats-dialog__body .stats__streak"),
    ).toBeNull();
  });

  it("opens directly on a deep-linked tab", () => {
    act(() =>
      root.render(createElement(Host, { initialTab: "achievements" })),
    );
    expect(host.textContent).toContain("In progress");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe(
      "Achievements",
    );
  });

  it("disables the period switcher on the period-independent Providers tab", () => {
    act(() => root.render(createElement(Host)));
    const periodButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>(".stats__period button")][0];
    expect(periodButton().disabled).toBe(false);

    clickTab("Providers");
    expect(periodButton().disabled).toBe(true);
    expect(host.querySelector(".stats__period--idle")).not.toBeNull();

    clickTab("Achievements");
    expect(periodButton().disabled).toBe(true);

    clickTab("Overview");
    expect(periodButton().disabled).toBe(false);
  });

  it("demotes a window whose reset passes while the dialog stays open", () => {
    // beforeEach mocked only the date; this test needs ticking timers too.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW - 60_000,
      sourcePaneId: "pane-1",
      windows: [{ usedPct: 90, resetsAt: NOW + 10_000, windowMinutes: 300 }],
    };
    usage.snapshot = { accounts: new Map([["codex", account]]), panes: new Map() };
    act(() => root.render(createElement(Host, { initialTab: "providers" })));

    expect(host.querySelector(".stats__window--expired")).toBeNull();
    expect(host.textContent).toContain("resets in");

    // The reset passes with no new report; the shared wall clock ticks and
    // the WHOLE card demotes together — caption, dim and join in agreement.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(host.querySelector(".stats__window--expired")).not.toBeNull();
    expect(host.textContent).toContain("reset passed");
    expect(host.textContent).not.toContain("this window");
  });

  it("reaches arbitrarily old events through the All period", () => {
    history.snapshot = ledger([
      usageEvent({ occurredAt: NOW - 400 * 24 * 60 * 60 * 1_000 }),
    ]);
    act(() => root.render(createElement(Host)));
    // Default 7d is empty: Overview keeps rendering (zero cards, Weeks
    // history reachable), while the period-LEDGER tabs still gate.
    expect(host.querySelectorAll(".stats__card b")[0].textContent).toBe("0");
    expect(host.querySelector(".stats__weeks")).not.toBeNull();
    clickTab("Models");
    expect(host.textContent).toContain("No usage recorded");
    clickTab("Overview");

    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "All",
    )!;
    act(() => all.click());
    expect(host.querySelectorAll(".stats__card b")[0].textContent).toBe("1.6k");
  });

  it("hands each tab the same period the switcher is showing", () => {
    // The one thing only the shell can get wrong: routing the selection to
    // the panel. What a panel does with a period is its own suite's.
    history.snapshot = ledger([
      usageEvent({ occurredAt: NOW - 400 * 24 * 60 * 60 * 1_000 }),
    ]);
    act(() => root.render(createElement(Host)));
    clickTab("Models");
    expect(host.textContent).toContain("No usage recorded");

    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "All",
    )!;
    act(() => all.click());
    expect(host.textContent).not.toContain("No usage recorded");
    expect(host.querySelector('[aria-label="Models"]')).not.toBeNull();
  });
});
