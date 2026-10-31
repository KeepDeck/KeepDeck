// @vitest-environment happy-dom
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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

/** The catalog the series colours read — this suite is not about colours,
 * so no agent is installed (every series is the overflow gray). */
const catalog = vi.hoisted(() => ({ agents: [], loading: false }));
vi.mock("../../app/useAgents", () => ({
  useAgents: () => catalog,
}));

/** The chip asks the runtime for one number; this suite is about WHERE the
 * dialog seats it, so the number is a constant here and the witness behind
 * it is tested in `activityWitness.test.ts`. */
const streak = vi.hoisted(() => ({ days: 0 }));
vi.mock("../../app/useStreakDays", () => ({
  useStreakDays: () => streak.days,
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

/** The panels, each a stand-in that records what the shell handed it: what
 * a panel renders is its own suite's, so the shell's cases read props, not
 * markup — and nothing here loads the chart. */
const panels = vi.hoisted(() => ({
  overview: vi.fn<(props: ComponentProps<typeof Overview>) => void>(),
  providers: vi.fn<(props: ComponentProps<typeof Providers>) => void>(),
  table: vi.fn<(props: ComponentProps<typeof StatsTable>) => void>(),
  achievements: vi.fn<(props: ComponentProps<typeof Achievements>) => void>(),
}));
vi.mock("./Overview", () => ({
  Overview: (props: ComponentProps<typeof Overview>) => {
    panels.overview(props);
    return null;
  },
}));
vi.mock("./Providers", () => ({
  Providers: (props: ComponentProps<typeof Providers>) => {
    panels.providers(props);
    return null;
  },
}));
vi.mock("./StatsTable", () => ({
  StatsTable: (props: ComponentProps<typeof StatsTable>) => {
    panels.table(props);
    return null;
  },
}));
vi.mock("./Achievements", () => ({
  Achievements: (props: ComponentProps<typeof Achievements>) => {
    panels.achievements(props);
    return null;
  },
}));

import type { AccountUsage } from "../../domain/usage";
import {
  TEST_NOW,
  usageEvent as baseEvent,
} from "../../domain/usage/history/event.testSupport";
import type { Achievements } from "./Achievements";
import type { Overview } from "./Overview";
import type { Providers } from "./Providers";
import type { StatsTable } from "./StatsTable";
import { StatsDialog, UsageStats } from "./StatsDialog";
import type { StatsTab } from "../../domain/usage/statsTabs";
import { present } from "@keepdeck/plugin-api/testing";

/** What the shell last handed a panel. */
const handed = <P,>(panel: Mock<(props: P) => void>, name: string): P =>
  present(panel.mock.lastCall, `${name}'s last render`)[0];
const overview = () => handed(panels.overview, "Overview");
const providers = () => handed(panels.providers, "Providers");
const table = () => handed(panels.table, "StatsTable");
const achievements = () => handed(panels.achievements, "Achievements");

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

const NOW = TEST_NOW;
/** This file's personality over the shared builder: a costed codex session
 * with a human pane name — the totals and rows the shell routes assert on
 * these, so the divergence is EXPLICIT here, not baked into a private copy
 * of the whole shape. */
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
 * the boundary only holds while nothing crosses it — so here every panel is
 * a stand-in, and the shell's cases read what it handed them. */
describe("UsageStats", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    history.snapshot = ledger([usageEvent()]);
    usage.snapshot = { accounts: new Map(), panes: new Map() };
    windowReports.snapshot = { ready: true, byKey: new Map() };
    vi.clearAllMocks();
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const clickTab = (label: string) => {
    const tab = present([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === label,
    ), "the matching element");
    act(() => tab.click());
  };

  const clickPeriod = (label: string) => {
    const period = present([...host.querySelectorAll<HTMLButtonElement>(".stats__period button")].find(
      (button) => button.textContent === label,
    ), "the matching element");
    act(() => period.click());
  };

  it("renders as its own global dialog, not a settings section", () => {
    const close = vi.fn();
    act(() => root.render(createElement(DialogHost, { onClose: close })));

    const dialog = present(document.body.querySelector('[role="dialog"]'), "the [role=\"dialog\"] element");
    expect(dialog.getAttribute("aria-label")).toBe("Statistics");
    expect(dialog.textContent).toContain("across every CLI and workspace");
    expect(dialog.closest(".modal-overlay")).not.toBeNull();
    expect(dialog.closest(".settings")).toBeNull();

    act(() => present(dialog.querySelector<HTMLButtonElement>(".ui-close"), "the .ui-close element").click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("hands Overview the period's totals, and the drill-down tabs their rows", () => {
    act(() => root.render(createElement(Host)));

    expect(overview().period).toBe(7);
    expect(overview().stats.totals).toMatchObject({ totalTokens: 1_600, providerCostUsd: 0.25 });

    clickTab("Models");
    expect(table()).toMatchObject({ title: "Models", mode: "model" });
    expect(table().rows.map((row) => row.model)).toEqual(["gpt-5.6-terra"]);

    clickTab("Sessions");
    expect(table()).toMatchObject({ title: "Sessions", mode: "session" });
    expect(table().rows.map((row) => [row.paneName, row.sessionId])).toEqual([
      ["auth-refactor", "session-123456789"],
    ]);
  });

  it("counts a just-appended event immediately, not after the next clock tick", () => {
    act(() => root.render(createElement(Host)));
    expect(overview().stats.totals.totalTokens).toBe(1_600);

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
    expect(overview().now).toBe(NOW + 5_000);
    expect(overview().stats.totals.totalTokens).toBe(101_600);
  });

  it("routes a new time range to Overview, which keeps the whole ledger for its weeks", () => {
    history.snapshot = ledger([usageEvent({ occurredAt: NOW - 2 * 24 * 60 * 60 * 1_000 })]);
    act(() => root.render(createElement(Host)));
    expect(overview().stats.eventCount).toBe(1); // default 7d

    clickPeriod("24h");
    // The period went empty, but Overview STAYS, handed the whole ledger:
    // an empty period must never hide the one period-independent block, its
    // Weeks history (review finding; Overview's own suite draws it).
    expect(overview().period).toBe(1);
    expect(overview().stats.eventCount).toBe(0);
    expect(overview().events).toBe(history.snapshot.events);
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
    expect(providers().accounts).toBe(usage.snapshot.accounts);
    expect(providers().reportsByKey).toBe(windowReports.snapshot.byKey);
    expect(host.textContent).not.toContain("Usage history is unavailable");
  });

  it("seats the streak chip in the footer, outside the tab body", () => {
    // WHERE it sits is the dialog's decision — the chip takes no props
    // precisely so it can live outside the tabs. What it then says is its own
    // suite's business (StreakBadge.test.tsx).
    streak.days = 4;
    act(() => root.render(createElement(DialogHost, { onClose: vi.fn() })));

    const footer = present(document.body.querySelector(".stats-dialog__actions"), "the .stats-dialog__actions element");
    expect(footer.querySelector(".stats__streak")).not.toBeNull();
    expect(
      document.body.querySelector(".stats-dialog__body .stats__streak"),
    ).toBeNull();
  });

  it("opens directly on a deep-linked tab", () => {
    act(() =>
      root.render(createElement(Host, { initialTab: "achievements" })),
    );
    expect(achievements().events).toBe(history.snapshot.events);
    expect(present(host.querySelector('[role="tab"][aria-selected="true"]'), "the [role=\"tab\"][aria-selected=\"true\"] element").textContent).toBe(
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

  it("ticks one shared clock past a reset while the dialog stays open", () => {
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
    expect(providers().now).toBe(NOW);

    // The reset passes with no new report: the wall clock ticks, and the
    // card is handed a now past it — the demotion it draws from that is
    // Providers' own suite's. Every tab reads the same clock.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(providers().now).toBeGreaterThan(NOW + 10_000);
    clickTab("Overview");
    expect(overview().now).toBe(providers().now);
  });

  it("reaches arbitrarily old events through the All period", () => {
    history.snapshot = ledger([
      usageEvent({ occurredAt: NOW - 400 * 24 * 60 * 60 * 1_000 }),
    ]);
    act(() => root.render(createElement(Host)));
    // Default 7d is empty: Overview keeps rendering, handed the whole ledger
    // for its Weeks, while the period-LEDGER tabs still gate.
    expect(overview().stats.eventCount).toBe(0);
    expect(overview().events).toBe(history.snapshot.events);
    clickTab("Models");
    expect(host.textContent).toContain("No usage recorded");
    clickTab("Overview");

    clickPeriod("All");
    expect(overview().period).toBe("all");
    expect(overview().stats.totals.totalTokens).toBe(1_600);
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

    clickPeriod("All");
    expect(host.textContent).not.toContain("No usage recorded");
    expect(table().rows.map((row) => row.model)).toEqual(["gpt-5.6-terra"]);
  });
});
