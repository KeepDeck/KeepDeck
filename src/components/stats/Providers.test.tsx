// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage, UsageWindow } from "../../domain/usage/usage";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import {
  TEST_NOW,
  usageEvent as baseEvent,
} from "../../domain/usage/history/event.testSupport";
import { accountWindowKeys } from "../../domain/usage/reportJournal";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { Providers } from "./Providers";

/** The provider section joined to a fixed instant. The dialog's own wiring —
 * the shared wall clock that advances this `now`, and the tab gating that
 * keeps this section alive when the ledger fails — is the shell's job and is
 * tested there; here the instant is a prop, so every case states the clock
 * it means instead of arranging one. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = TEST_NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;

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

describe("Providers", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
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
  }: {
    accounts: Map<string, AccountUsage>;
    events?: UsageEventV2[];
    reportsByKey?: Map<string, readonly WindowReport[]>;
  }) {
    act(() =>
      root.render(
        createElement(Providers, { accounts, events, reportsByKey, now: NOW }),
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

  it("joins provider windows with ledger spend inside each window", () => {
    render({
      accounts: new Map([
        [
          "codex",
          account([
            { usedPct: 34, resetsAt: NOW + 2 * HOUR, windowMinutes: 300 },
            { usedPct: 51, resetsAt: null, windowMinutes: 10_080 },
          ]),
        ],
      ]),
    });

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

  it("forecasts the race and draws the burn curve when the journal has pace", () => {
    const resetsAt = NOW + 155 * MIN;
    const windows = [{ usedPct: 62, resetsAt, windowMinutes: 300 }];
    const claude = account(windows, NOW);
    // 0.29%/min over 40 minutes of reports: 38% left ≈ 131m < 155m to reset.
    const reports = [50.4, 53.3, 56.2, 59.1, 62].map((usedPct, index) => ({
      agent: "claude",
      windowMinutes: 300,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt,
    }));
    render({
      accounts: new Map([["claude", claude]]),
      reportsByKey: new Map([
        [accountWindowKeys("claude", windows).get(windows[0])!.key, reports],
      ]),
    });

    expect(host.textContent).toContain("on pace to run out");
    expect(host.textContent).toContain("early");
    expect(host.textContent).toContain("resets in 2h 35m");
    expect(host.querySelector(".usage-burn")).not.toBeNull();
    expect(host.querySelector(".usage-burn__dot--warn")).not.toBeNull();
  });

  it("stays silent about the race when the journal has no pace yet", () => {
    render({
      accounts: new Map([
        [
          "claude",
          account(
            [{ usedPct: 62, resetsAt: NOW + 155 * MIN, windowMinutes: 300 }],
            NOW,
          ),
        ],
      ]),
    });
    expect(host.textContent).toContain("resets in 2h 35m");
    expect(host.textContent).not.toContain("on pace");
    expect(host.querySelector(".usage-burn")).toBeNull();
  });

  it("demotes expired and stale windows instead of joining them", () => {
    render({
      accounts: new Map([
        [
          "claude",
          account(
            [
              { usedPct: 10, resetsAt: NOW - HOUR, windowMinutes: 300 }, // expired
              { usedPct: 81, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 },
            ],
            NOW - 2 * HOUR, // stale report
          ),
        ],
      ]),
      events: [usageEvent({ agent: "claude" })],
    });

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
    render({
      accounts: new Map([
        [
          "kimi",
          account([
            { usedPct: 0, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10_080 },
          ]),
        ],
      ]),
    });
    expect(host.textContent).toContain("no usage this window");
    expect(host.textContent).not.toContain("0 sessions");
  });
});
