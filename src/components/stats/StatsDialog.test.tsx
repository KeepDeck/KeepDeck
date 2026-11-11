// @vitest-environment happy-dom
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { UsageRow } from "../../domain/usage/history/event";

const history = vi.hoisted(() => ({
  snapshot: {
    ready: true,
    ledger: { events: [] as readonly UsageRow[], version: 0 },
    error: null as string | null,
    complete: true,
    perModelSince: null as number | null,
  },
}));

/** A ready snapshot of the whole ledger — the healthy case these cases mean
 * whenever they do not say otherwise. */
const ledger = (events: UsageRow[]) => ({
  ready: true,
  ledger: { events, version: 1 },
  error: null as string | null,
  complete: true,
  perModelSince: null as number | null,
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
  breakdown: vi.fn<(props: ComponentProps<typeof Breakdown>) => void>(),
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
vi.mock("./Breakdown", () => ({
  Breakdown: (props: ComponentProps<typeof Breakdown>) => {
    panels.breakdown(props);
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
  type UsageRowOverrides,
} from "../../domain/usage/history/event.testSupport";
import type { Achievements } from "./Achievements";
import type { Overview } from "./Overview";
import type { Providers } from "./Providers";
import type { Breakdown } from "./Breakdown";
import { StatsDialog, UsageStats } from "./StatsDialog";
import { useStatsView } from "../../app/useStatsView";
import { returnTab } from "../../presentation/stats/statsTabs";
import type { StatsTab } from "../../domain/usage/statsTabs";
import { present } from "@keepdeck/plugin-api/testing";

/** The kept awards are the notifier's, through the runtime; these cases are
 * about the ledger's own crossings, so none is kept. */
vi.mock("../../app/useKeptAchievements", () => ({ useKeptAchievements: () => new Set<string>() }));

/** What the shell last handed a panel. */
const handed = <P,>(panel: Mock<(props: P) => void>, name: string): P =>
  present(panel.mock.lastCall, `${name}'s last render`)[0];
const overview = () => handed(panels.overview, "Overview");
const providers = () => handed(panels.providers, "Providers");
const breakdown = () => handed(panels.breakdown, "Breakdown");
const achievements = () => handed(panels.achievements, "Achievements");

/** The dialog's tab and view are controlled by app-layer owners; tests
 * host that ownership in a tiny stateful wrapper — the view through the
 * real owner hook. */
/** No pane holds any session in these cases. */
const NO_SESSIONS = { held: () => false, reveal: () => {} };

/** The router's tab memory, as the app-layer owner keeps it. */
function useTab(initialTab: StatsTab) {
  const [state, setState] = useState({ tab: initialTab, from: "overview" as StatsTab });
  const onSelectTab = (tab: StatsTab) => setState((at) => ({ tab, from: returnTab(at.tab, at.from) }));
  return { tab: state.tab, from: state.from, onSelectTab };
}

function Host({ initialTab = "overview" }: { initialTab?: StatsTab }) {
  return createElement(UsageStats, { ...useTab(initialTab), view: useStatsView(), journal: {}, sessions: NO_SESSIONS });
}

function DialogHost({ onClose = () => {} }: { onClose?: () => void }) {
  return createElement(StatsDialog, { ...useTab("overview"), view: useStatsView(), journal: {}, sessions: NO_SESSIONS, onClose });
}

const NOW = TEST_NOW;
/** This file's personality over the shared builder: a costed codex session
 * with a human pane name — the totals and rows the shell routes assert on
 * these, so the divergence is EXPLICIT here, not baked into a private copy
 * of the whole shape. */
const usageEvent = (over: UsageRowOverrides = {}): UsageRow =>
  baseEvent({
    capturedAt: NOW,
    paneName: "auth-refactor",
    sessionId: "session-123456789",
    rootSessionId: "session-123456789",
    tokens: { input: 1_000, output: 100, cacheRead: 500 },
    costUsd: 0.25,
    ...over,
  });

/** The shell: the stats dialog routes a tab or period choice to the panel
 * that answers it, and keeps the shared clock and the ledger's failure
 * honest across that boundary.
 *
 * What a panel then renders belongs to the panel's own suite, and every one
 * of them now has one — Overview, Breakdown, Providers, Achievements,
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
    // The dialog's overlay renders outside the host; the strip is found
    // wherever it is mounted.
    const tab = present([...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
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
    // The header names the calendar days the default 7 days cover.
    expect(dialog.textContent).toContain("Jul 16 – Jul 22");
    expect(dialog.closest(".modal-overlay")).not.toBeNull();
    expect(dialog.closest(".settings")).toBeNull();

    act(() => present(dialog.querySelector<HTMLButtonElement>(".ui-close"), "the .ui-close element").click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens the badge gallery from the footer, and Escape peels it before the dialog", () => {
    const close = vi.fn();
    act(() => root.render(createElement(DialogHost, { onClose: close })));
    clickTab("Weekly");
    const door = present(
      [...document.body.querySelectorAll<HTMLButtonElement>(".stats-dialog__actions .stats__link")].find((b) =>
        b.textContent?.startsWith("Achievements"),
      ),
      "the gallery door",
    );
    // The default ledger has crossed two first tiers already.
    expect(door.textContent).toBe("Achievements · 2 earned →");
    act(() => door.click());
    expect(achievements().ledger).toBe(history.snapshot.ledger);

    const escape = () =>
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    escape();
    // Back on the tab the gallery was opened from, the dialog still open.
    expect(close).not.toHaveBeenCalled();
    expect(present(document.body.querySelector('[role="tab"][aria-selected="true"]'), "the selected tab").textContent).toBe("Weekly");
    escape();
    expect(close).toHaveBeenCalledOnce();
  });

  it("hands Overview and Breakdown the period and the whole ledger", () => {
    act(() => root.render(createElement(Host)));

    expect(overview().period).toBe(7);
    expect(overview().ledger).toBe(history.snapshot.ledger);

    clickTab("Breakdown");
    expect(breakdown()).toMatchObject({ period: 7, dimension: "workspace", order: "cost" });
    expect(breakdown().ledger).toBe(history.snapshot.ledger);
  });

  it("opens Breakdown on the dimension an Overview list names, and keeps the pick", () => {
    act(() => root.render(createElement(Host)));
    act(() => overview().onOpenBreakdown("model"));
    expect(breakdown()).toMatchObject({ dimension: "model" });
    act(() => breakdown().onSelectOrder("change"));
    expect(breakdown()).toMatchObject({ dimension: "model", order: "change" });
  });

  it("counts a just-appended event immediately, not after the next clock tick", () => {
    act(() => root.render(createElement(Host)));
    expect(overview().now).toBe(NOW);

    // An agent finishes a turn seconds AFTER the dialog's slow clock last
    // ticked: the appended event's instant is ahead of that clock, and the
    // `occurredAt <= now` filter must not hide it for up to 30s.
    history.snapshot = ledger([
      usageEvent(),
      usageEvent({
        occurredAt: NOW + 5_000,
        capturedAt: NOW + 5_000,
        tokens: { input: 100_000 },
      }),
    ]);
    act(() => root.render(createElement(Host)));
    expect(overview().now).toBe(NOW + 5_000);
  });

  it("routes a new time range to Overview, which keeps the whole ledger", () => {
    history.snapshot = ledger([usageEvent({ occurredAt: NOW - 2 * 24 * 60 * 60 * 1_000 })]);
    act(() => root.render(createElement(Host)));
    expect(overview().period).toBe(7);

    clickPeriod("Today");
    // The period went empty, but Overview STAYS, handed the whole ledger:
    // its comparison and its limits glance read past the period.
    expect(overview().period).toBe(1);
    expect(overview().ledger).toBe(history.snapshot.ledger);
  });

  it("keeps Limits alive when the ledger failed to load", () => {
    history.snapshot = {
      ready: true,
      ledger: { events: [], version: 0 },
      error: "ledger read failed",
      complete: false,
      perModelSince: null as number | null,
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
    clickTab("Limits");
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

  it("opens directly on a deep-linked destination, off the strip, with the way back", () => {
    act(() =>
      root.render(createElement(Host, { initialTab: "achievements" })),
    );
    expect(achievements().ledger).toBe(history.snapshot.ledger);
    // The gallery is no tab of the strip: none is selected, the panel names it.
    expect(host.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
    expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "Overview", "Breakdown", "Limits", "Weekly",
    ]);
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute("aria-label")).toBe("Achievements");
    const back = present(host.querySelector<HTMLButtonElement>(".stats__back"), "the way back");
    expect(back.textContent).toBe("‹ Overview");
    act(() => back.click());
    expect(present(host.querySelector('[role="tab"][aria-selected="true"]'), "the selected tab").textContent).toBe("Overview");
  });

  it("selects and focuses the next tab on an arrow, wrapping past the last", () => {
    act(() => root.render(createElement(Host, { initialTab: "weekly" })));
    const strip = present(host.querySelector<HTMLElement>('[role="tablist"]'), "the tab strip");
    act(() => {
      strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const selected = present(host.querySelector('[role="tab"][aria-selected="true"]'), "the selected tab");
    expect(selected.textContent).toBe("Overview");
    expect(document.activeElement).toBe(selected);
    expect(overview().period).toBe(7);
  });

  it("disables the period switcher on the period-independent Limits tab", () => {
    act(() => root.render(createElement(Host)));
    const periodButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>(".stats__period button")][0];
    expect(periodButton().disabled).toBe(false);

    clickTab("Limits");
    expect(periodButton().disabled).toBe(true);
    expect(host.querySelector(".stats__period--idle")).not.toBeNull();

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
    act(() => root.render(createElement(Host, { initialTab: "limits" })));
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
    // The default 7 days are empty: Overview keeps rendering, handed the
    // whole ledger, while the period-LEDGER tabs still gate.
    expect(overview().ledger).toBe(history.snapshot.ledger);
    clickTab("Breakdown");
    expect(host.textContent).toContain("No usage recorded");
    clickTab("Overview");

    clickPeriod("All");
    expect(overview().period).toBe("all");
  });

  it("narrows Overview and Breakdown to a picked workspace, and shows no scope on Limits", () => {
    history.snapshot = ledger([usageEvent({ workspaceName: "KeepDeck" }), usageEvent({ workspaceName: "Docs" })]);
    act(() => root.render(createElement(Host)));
    const chip = (label: string) =>
      present([...host.querySelectorAll<HTMLButtonElement>(".stats__scope button")].find((b) => b.textContent === label), label);
    expect(overview().workspace).toBeNull();
    act(() => chip("Docs").click());
    expect(overview().workspace).toBe("Docs");
    clickTab("Breakdown");
    expect(breakdown().workspace).toBe("Docs");
    clickTab("Limits");
    expect(host.querySelector(".stats__scope")).toBeNull();
  });

  it("hands Breakdown the ledger's switch to per-model booking", () => {
    history.snapshot = { ...ledger([usageEvent()]), perModelSince: NOW - 60_000 };
    act(() => root.render(createElement(Host)));
    clickTab("Breakdown");
    expect(breakdown().perModelSince).toBe(NOW - 60_000);
  });

  it("hands each tab the same period the switcher is showing", () => {
    // The one thing only the shell can get wrong: routing the selection to
    // the panel. What a panel does with a period is its own suite's.
    history.snapshot = ledger([
      usageEvent({ occurredAt: NOW - 400 * 24 * 60 * 60 * 1_000 }),
    ]);
    act(() => root.render(createElement(Host)));
    clickTab("Breakdown");
    expect(host.textContent).toContain("No usage recorded");

    clickPeriod("All");
    expect(host.textContent).not.toContain("No usage recorded");
    expect(breakdown().period).toBe("all");
  });
});
