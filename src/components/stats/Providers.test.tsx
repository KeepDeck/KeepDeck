// @vitest-environment happy-dom
import { act, createElement } from "react";
import { ledgerOf } from "../../domain/usage/history/ledger.testSupport";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMoment, type AccountUsage, type UsageWindow } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import {
  TEST_NOW,
  usageEvent as baseEvent,
  type UsageRowOverrides,
} from "../../domain/usage/history/event.testSupport";
import { accountWindowKeys } from "../../domain/usage/reportJournal";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { Providers } from "./Providers";
import { present } from "@keepdeck/plugin-api/testing";

/** The provider section joined to a fixed instant. The dialog's own wiring —
 * the shared wall clock that advances this `now`, and the tab gating that
 * keeps this section alive when the ledger fails — is the shell's job and is
 * tested there; here the instant is a prop, so every case states the clock
 * it means instead of arranging one. */

const NOW = TEST_NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;

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

describe("Providers", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  function render({
    accounts,
    events = [usageEvent()],
    reportsByKey = new Map<string, readonly WindowReport[]>(),
    now = NOW,
  }: {
    accounts: Map<string, AccountUsage>;
    events?: UsageRow[];
    reportsByKey?: Map<string, readonly WindowReport[]>;
    now?: number;
  }) {
    act(() =>
      root.render(
        createElement(Providers, { accounts, ledger: ledgerOf(events), colors: new Map(), reportsByKey, now, measure: "spend" }),
      ),
    );
  }

  /** A reported account; only the two things these cases vary are settable,
   * so the union's discriminant cannot be widened by an override. */
  const account = (
    windows: UsageWindow[],
    reportedAt = NOW - MIN,
  ): AccountUsage => ({
    kind: "reported",
    reportedAt,
    sourcePaneId: "pane-1",
    windows,
  });

  it("draws one card per provider around its longest window: a lead tile beside its chart, the shorter one a small tile", () => {
    render({
      accounts: new Map([
        [
          "codex",
          account([
            { usedPct: 34, resetsAt: NOW + 2 * HOUR, windowMinutes: 300 },
            { usedPct: 51, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 },
          ]),
        ],
      ]),
    });
    const cards = host.querySelectorAll(".stats__provider");
    expect(cards).toHaveLength(1);
    const card = present(cards[0], "the codex card");
    // The name and the report age once, in the head.
    expect(card.querySelector(".stats__provider-head")?.textContent).toBe("codexUpdated 1m ago");
    const lead = present(card.querySelector(".stats__window--lead"), "the lead tile");
    expect(lead.textContent).toContain("week");
    expect(lead.textContent).toContain("51%");
    const [, small] = [...card.querySelectorAll(".stats__window")];
    expect(small?.textContent).toContain("5h");
    expect(small?.textContent).toContain("34%");
    expect(small?.textContent).toContain(`resets in 2h 0m · ${formatMoment(NOW + 2 * HOUR, NOW)}`);
    // Each tile draws the shared fill bar with a tick where its time stands.
    expect(card.querySelectorAll(".usage-bar")).toHaveLength(2);
    expect(card.querySelectorAll(".stats__window-time")).toHaveLength(2);
    // The chart names its start, its reset and now, and marks the 5h window in it.
    const chart = present(card.querySelector(".stats__limits-chart"), "the chart");
    expect(chart.querySelector(".stats__limits-edges")?.textContent).toMatch(/^started .+resets .+$/);
    expect(chart.querySelector(".stats__limits-now-label")?.textContent).toMatch(/^now · /);
    expect(chart.querySelectorAll(".stats__limits-ticks span").length).toBeGreaterThan(0);
    expect(chart.querySelector(".stats__limits-note")?.textContent).toMatch(/^5h window · /);
  });

  it("says the race on the lead tile's own line, and marks the run-out on the chart's ceiling", () => {
    const resetsAt = NOW + 155 * MIN;
    const windows = [{ usedPct: 62, resetsAt, windowMinutes: 300 }];
    // 0.29%/min over 40 minutes of reports: 38% left ≈ 131m < 155m to reset.
    const reports = [50.4, 53.3, 56.2, 59.1, 62].map((usedPct, index) => ({
      agent: "claude",
      windowMinutes: 300,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt,
    }));
    render({
      accounts: new Map([["claude", account(windows, NOW)]]),
      reportsByKey: new Map([[present(accountWindowKeys("claude", windows).get(windows[0]), "the window's key").key, reports]]),
    });
    // The phrase and its unit, not the exact minute: the domain suite owns the arithmetic.
    expect(host.querySelector(".stats__window--lead")?.textContent).toMatch(/Will hit the limit in ~2h \d+m/);
    expect(host.querySelector(".stats__limits-out.usage-level--warn")).not.toBeNull();
    expect(host.querySelector(".stats__limits-projection")).not.toBeNull();
  });

  it("says when there is no pace to read yet, and draws no projection", () => {
    render({ accounts: new Map([["claude", account([{ usedPct: 62, resetsAt: NOW + 155 * MIN, windowMinutes: 300 }], NOW)]]) });
    expect(host.textContent).toContain("Not enough data yet");
    expect(host.textContent).not.toContain("the limit");
    expect(host.querySelector(".stats__limits-projection")).toBeNull();
  });

  it("dims a reset window on its own small tile, and says a stale report's age once", () => {
    render({
      accounts: new Map([
        [
          "claude",
          account(
            [
              { usedPct: 10, resetsAt: NOW - HOUR, windowMinutes: 300 }, // reset
              { usedPct: 81, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 },
            ],
            NOW - 2 * HOUR, // stale report
          ),
        ],
      ]),
      events: [usageEvent({ agent: "claude" })],
    });
    const card = present(host.querySelector(".stats__provider"), "the claude card");
    expect(card.querySelector(".stats__provider-head small")?.className).toBe("usage-level--warn");
    expect(card.querySelector(".stats__provider-head")?.textContent).toContain("Updated 2h ago");
    const reset = present(card.querySelector(".stats__window--expired"), "the reset tile");
    expect(reset.textContent).toContain("reset — waiting for its next report");
    expect(reset.querySelector(".stats__window-time")).toBeNull();
    // The live week still leads, with its chart.
    expect(card.querySelector(".stats__window--lead")?.textContent).toContain("week");
    expect(card.querySelector(".stats__limits-chart")).not.toBeNull();
  });

  it("demotes a window on the card already drawn, the moment the now it is handed passes its reset", () => {
    // The dialog's clock ticks on with no new report, event or journal
    // entry: the very same inputs, only a later now.
    const inputs = {
      accounts: new Map([["codex", account([{ usedPct: 90, resetsAt: NOW + 10_000, windowMinutes: 300 }])]]),
      events: [usageEvent()],
      reportsByKey: new Map<string, readonly WindowReport[]>(),
    };
    render(inputs);
    expect(host.querySelector(".stats__window--expired")).toBeNull();
    expect(host.querySelector(".stats__limits-chart")).not.toBeNull();

    render({ ...inputs, now: NOW + 31_000 });
    expect(host.querySelector(".stats__window--expired")).not.toBeNull();
    expect(host.textContent).toContain("reset — waiting for its next report");
    expect(host.querySelector(".stats__limits-chart")).toBeNull();
  });

  it("stands this machine's usage under the chart, and says once what the bars count", () => {
    render({
      accounts: new Map([["codex", account([{ usedPct: 20, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 }])]]),
      events: [usageEvent({ occurredAt: NOW - HOUR })],
    });
    const bars = [...host.querySelectorAll<HTMLElement>(".stats__limits-bars i")];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.some((bar) => bar.style.height === "100.00%")).toBe(true);
    expect(host.querySelectorAll(".stats__coverage")).toHaveLength(1);
    expect(host.querySelector(".stats__coverage")?.textContent).toMatch(/^Bars are this machine's spend at list price/);
  });

  it("draws a day of usage no price covers as a hollow bar", () => {
    render({
      accounts: new Map([["codex", account([{ usedPct: 20, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 }])]]),
      events: [usageEvent({ occurredAt: NOW - HOUR, costUsd: undefined })],
    });
    expect(host.querySelectorAll(".stats__limits-bar--unpriced")).toHaveLength(1);
    expect(host.querySelector(".stats__coverage")?.textContent).toMatch(/a hollow one has none priced\.$/);
  });

  it("says how the tab fills before any CLI reports its limits", () => {
    render({ accounts: new Map() });
    expect(host.textContent).toBe("No provider reports yet. Windows appear once a CLI reports its account limits.");
  });
});
