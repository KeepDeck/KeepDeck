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
/** A mark for codex alone: the others have none and fall back to a prompt. */
const ICONS = new Map([["codex", { viewBox: "0 0 10 10", paths: [{ d: "M0 0h10v10H0z" }] }]]);
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
        createElement(Providers, { accounts, ledger: ledgerOf(events), colors: new Map(), agentIcons: ICONS, reportsByKey, now }),
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

  it("draws one card per provider, and in it each live window beside its own chart", () => {
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
    // The name and the report age once, in the head — named by the agent's
    // own mark, as the deck names it, not by a dot of its line's colour.
    expect(card.querySelector(".stats__provider-head")?.textContent).toBe("codexUpdated 1m ago");
    expect(card.querySelector(".stats__provider-head svg path")?.getAttribute("d")).toBe("M0 0h10v10H0z");
    expect(card.querySelector(".stats__provider-head i")).toBeNull();
    // The fuller week first, then the 5h window — each a tile and a chart.
    const rows = [...card.querySelectorAll(".stats__provider-row")];
    expect(rows.map((row) => row.querySelector(".stats__window-label")?.textContent)).toEqual(["week", "5h"]);
    expect(rows.every((row) => row.querySelector(".stats__limits-chart") !== null)).toBe(true);
    expect(rows[1]?.textContent).toContain(`resets in 2h 0m · ${formatMoment(NOW + 2 * HOUR, NOW)}`);
    // The 5h chart runs on its own hours.
    expect(rows[1]?.querySelector(".stats__limits-ticks")?.textContent).toMatch(/\d\d:00/);
    // Each tile draws the shared fill bar, and nothing on it but the fill.
    expect(card.querySelectorAll(".usage-bar")).toHaveLength(2);
    expect(card.querySelectorAll(".stats__window-bar > i")).toHaveLength(0);
    const chart = present(rows[0]?.querySelector(".stats__limits-chart"), "the week's chart");
    expect(chart.querySelector(".stats__limits-edges")?.textContent).toMatch(/^started .+resets .+$/);
    expect(chart.querySelector(".stats__limits-now-label")?.textContent).toMatch(/^now · /);
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
    expect(host.querySelector(".stats__limits-end.usage-level--warn")).not.toBeNull();
    expect(host.querySelector(".stats__limits-end-label")?.textContent).toMatch(/^limit ~/);
    expect(host.querySelector(".stats__limits-projection")).not.toBeNull();
  });

  it("says when there is no pace to read yet, and draws no projection", () => {
    render({ accounts: new Map([["claude", account([{ usedPct: 62, resetsAt: NOW + 155 * MIN, windowMinutes: 300 }], NOW)]]) });
    expect(host.textContent).toContain("No forecast yet — too few recent reports");
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
    // The live week is charted; the reset 5h window is a small tile.
    expect(card.querySelector(".stats__provider-row .stats__window-label")?.textContent).toBe("week");
    expect(card.querySelector(".stats__provider-others .stats__window--expired")).not.toBeNull();
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

  it("draws no usage bars — the user wants none on Limits — and so no note about them", () => {
    render({
      accounts: new Map([["codex", account([{ usedPct: 20, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 }])]]),
      events: [usageEvent({ occurredAt: NOW - HOUR })],
    });
    expect(host.querySelector(".stats__limits-chart")).not.toBeNull();
    expect(host.querySelector(".stats__limits-bars")).toBeNull();
    expect(host.querySelector(".stats__coverage")).toBeNull();
  });

  it("opens a dated card where the pointer is: reported or projected, and this machine's day", () => {
    render({
      accounts: new Map([["codex", account([{ usedPct: 20, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 }])]]),
      events: [usageEvent({ occurredAt: NOW - HOUR })],
    });
    const area = present(host.querySelector<HTMLElement>(".stats__limits-plot"), "the plot");
    area.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1000, bottom: 120, width: 1000, height: 120, x: 0, y: 0, toJSON: () => ({}) });
    // The lone reading stands four days into the week: at 4/7 of the plot.
    act(() => area.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 571, clientY: 100 })));
    const card = present(document.querySelector<HTMLElement>("[role='tooltip']"), "the hover card");
    expect(card.textContent).toContain("Observed");
    expect(card.textContent).toContain("20% used");
    expect(card.textContent).toMatch(/This machine that day: .+ tokens/);
    expect(area.querySelector(".stats__limits-cursor")).not.toBeNull();
    act(() => area.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
    expect(document.querySelector("[role='tooltip']")).toBeNull();
    // From the keyboard, the point is read aloud as it moves.
    act(() => area.focus());
    act(() => area.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(host.querySelector("[role='status']")?.textContent).toMatch(/: Observed, 20% used/);
  });

  it("says of a lone reading that it is one", () => {
    render({
      accounts: new Map([["codex", account([{ usedPct: 20, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 }])]]),
      events: [usageEvent({ agent: "claude", occurredAt: NOW - HOUR })],
    });
    expect(host.querySelector(".stats__limits-lone")?.textContent).toBe("1 report so far");
  });

  it("says how the tab fills before any CLI reports its limits", () => {
    render({ accounts: new Map() });
    expect(host.textContent).toBe("No provider reports yet. Windows appear once a CLI reports its account limits.");
  });
});
