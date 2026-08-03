// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../../domain/usage/history/event";

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
import { accountWindowKeys } from "../../domain/usage/reportJournal";
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

describe("UsageStats", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    history.snapshot = { ready: true, events: [usageEvent()], error: null };
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
    history.snapshot = {
      ready: true,
      events: [
        usageEvent(),
        usageEvent({
          occurredAt: NOW + 5_000,
          capturedAt: NOW + 5_000,
          tokens: { input: 100_000 },
          observation: { tokens: { input: 100_000 } },
        }),
      ],
      error: null,
    };
    act(() => root.render(createElement(Host)));
    expect(host.textContent).toContain("101.6k");
  });

  it("switches time ranges without remounting", () => {
    history.snapshot = {
      ready: true,
      events: [usageEvent({ occurredAt: NOW - 2 * 24 * 60 * 60 * 1_000 })],
      error: null,
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
    act(() => root.render(createElement(Host)));

    const recap = host.querySelector(".stats__recap")!;
    expect(recap.textContent).toContain("+100% vs prior 7d");
    expect(recap.textContent).toContain("top model gpt-5.6-terra (1.6k)");
    expect(recap.textContent).toContain("busiest day Jul 22 (1.6k)");
  });

  it("keeps Providers alive when the ledger failed to load", () => {
    history.snapshot = { ready: true, events: [], error: "ledger read failed" };
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
    act(() => root.render(createElement(Host)));
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

  it("splits the achievements tab into In progress, Earned and Locked", () => {
    history.snapshot = {
      ready: true,
      events: [
        usageEvent({ tokens: { input: 2_000_000 } }),
      ],
      error: null,
    };
    act(() => root.render(createElement(Host)));
    clickTab("Achievements");

    const sections = [...host.querySelectorAll(".stats__section")];
    const byTitle = (title: string) =>
      sections.find(
        (section) => section.querySelector("h3")?.textContent === title,
      )!;
    const inProgress = byTitle("In progress");
    const earned = byTitle("Earned");
    const locked = byTitle("Locked");

    // The sections appear in that order — in-progress goals lead.
    expect(sections.indexOf(inProgress)).toBeLessThan(sections.indexOf(earned));
    expect(sections.indexOf(earned)).toBeLessThan(sections.indexOf(locked));

    expect(earned.textContent).toContain("First Million");
    expect(earned.textContent).toContain("earned Jul 22, 2026");
    expect(earned.textContent).toContain("Hello, Agent");

    // One goal per ladder, with progress…
    expect(inProgress.textContent).toContain("Picking Up Steam");
    expect(inProgress.textContent).toContain("2M / 10M");
    expect(inProgress.textContent).toContain("First Dollar");
    expect(inProgress.textContent).toContain("$0.25 / $1");
    // …while the tiers beyond it are visible but inert: present in Locked,
    // without a progress bar.
    expect(locked.textContent).toContain("Heavy Rotation");
    expect(locked.textContent).toContain("Trillionaire");
    expect(locked.querySelector(".stats__achievement-progress")).toBeNull();
    expect(
      locked.querySelector(".stats__achievement--future"),
    ).not.toBeNull();
  });

  it("carries a hover tooltip with exact numbers on every card", () => {
    history.snapshot = {
      ready: true,
      events: [usageEvent({ tokens: { input: 2_000_000 } })],
      error: null,
    };
    act(() => root.render(createElement(Host)));
    clickTab("Achievements");

    // Tips live behind the shared Tooltip now: nothing renders until the
    // card is hovered or focused, then the layer PORTALS to the body so
    // the scroller cannot clip it. Focus opens without the hover delay.
    const cards = [...host.querySelectorAll(".stats__achievement")];
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    const focus = (card: Element, on: boolean) =>
      act(() => {
        card.dispatchEvent(
          new FocusEvent(on ? "focusin" : "focusout", { bubbles: true }),
        );
      });
    const steam = cards.find((card) =>
      card.textContent?.includes("Picking Up Steam"),
    )!;
    focus(steam, true);
    expect(document.querySelector('[role="tooltip"]')!.textContent).toContain(
      "2,000,000 of 10,000,000 — 20%",
    );
    focus(steam, false);
    const earned = cards.find((card) =>
      card.textContent?.includes("First Million"),
    )!;
    focus(earned, true);
    expect(document.querySelector('[role="tooltip"]')!.textContent).toContain(
      "Earned Jul 22, 2026",
    );
    focus(earned, false);
  });

  it("shows the live streak chip in the footer corner with its heat tier", () => {
    const DAY = 24 * 60 * 60 * 1_000;
    history.snapshot = {
      ready: true,
      events: [0, 1, 2, 3].map((daysAgo) =>
        usageEvent({ eventId: `d-${daysAgo}`, occurredAt: NOW - daysAgo * DAY }),
      ),
      error: null,
    };
    act(() => root.render(createElement(DialogHost, { onClose: vi.fn() })));

    const footer = document.body.querySelector(".stats-dialog__actions")!;
    const chip = footer.querySelector(".stats__streak")!;
    expect(chip.getAttribute("aria-label")).toBe("4-day streak");
    expect(chip.className).toContain("stats__streak--ember");
    // The ember tier wears the coal mark, not a flame yet.
    expect(chip.querySelector(".stats__streak-mark")).not.toBeNull();
    expect(chip.querySelector(".stats__streak-coal")).not.toBeNull();
    expect(chip.querySelector(".stats__streak-fire")).toBeNull();
  });

  it("hides the streak chip when the streak is broken", () => {
    history.snapshot = {
      ready: true,
      events: [
        usageEvent({ occurredAt: NOW - 5 * 24 * 60 * 60 * 1_000 }),
      ],
      error: null,
    };
    act(() => root.render(createElement(DialogHost, { onClose: vi.fn() })));
    expect(document.body.querySelector(".stats__streak")).toBeNull();
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

  it("forecasts the race and draws the burn curve when the journal has pace", () => {
    const MIN = 60_000;
    const resetsAt = NOW + 155 * MIN;
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW,
      sourcePaneId: "pane-1",
      windows: [{ usedPct: 62, resetsAt, windowMinutes: 300 }],
    };
    usage.snapshot = { accounts: new Map([["claude", account]]), panes: new Map() };
    // 0.29%/min over 40 minutes of reports: 38% left ≈ 131m < 155m to reset.
    const reports = [50.4, 53.3, 56.2, 59.1, 62].map((usedPct, index) => ({
      agent: "claude",
      windowMinutes: 300,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt,
    }));
    windowReports.snapshot = {
      ready: true,
      byKey: new Map([
        [
          accountWindowKeys("claude", account.windows).get(account.windows[0])!
            .key,
          reports,
        ],
      ]),
    };
    act(() => root.render(createElement(Host, { initialTab: "providers" })));

    expect(host.textContent).toContain("on pace to run out");
    expect(host.textContent).toContain("early");
    expect(host.textContent).toContain("resets in 2h 35m");
    expect(host.querySelector(".usage-burn")).not.toBeNull();
    expect(host.querySelector(".usage-burn__dot--warn")).not.toBeNull();
  });

  it("stays silent about the race when the journal has no pace yet", () => {
    const account: AccountUsage = {
      kind: "reported",
      reportedAt: NOW,
      sourcePaneId: "pane-1",
      windows: [{ usedPct: 62, resetsAt: NOW + 155 * 60_000, windowMinutes: 300 }],
    };
    usage.snapshot = { accounts: new Map([["claude", account]]), panes: new Map() };
    act(() => root.render(createElement(Host, { initialTab: "providers" })));
    expect(host.textContent).toContain("resets in 2h 35m");
    expect(host.textContent).not.toContain("on pace");
    expect(host.querySelector(".usage-burn")).toBeNull();
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
    act(() => root.render(createElement(Host)));
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
    act(() => root.render(createElement(Host)));
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

  it("does not render unknown cost as a fake zero", () => {
    history.snapshot = {
      ready: true,
      events: [usageEvent({ costUsd: undefined, costSource: "unavailable" })],
      error: null,
    };
    act(() => root.render(createElement(Host)));

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
