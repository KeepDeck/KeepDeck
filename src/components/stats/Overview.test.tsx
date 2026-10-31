// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import {
  TEST_NOW,
  usageEvent as baseEvent,
} from "../../domain/usage/history/event.testSupport";
import {
  queryUsageStats,
  type UsageStatsPeriod,
} from "../../domain/usage/history/query";
import { Overview } from "./Overview";
import { present } from "@keepdeck/plugin-api/testing";

// The chart is its own suite's (UsageChart.test.tsx). Overview loads it
// lazily, so a stand-in here keeps recharts out of this file, and each render
// settles the lazy load inside its own act.
vi.mock("./UsageChart", () => ({ UsageChart: () => null }));

/** The Overview body: headline numbers, the recap sentence, the coverage
 * disclaimer and the period-independent Weeks block. It takes the queried
 * stats as a prop, so the cases here state a ledger and let the domain
 * answer — no dialog, no tab, no mocked hooks. */

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1_000;

const usageEvent = (over: Record<string, unknown> = {}): UsageEventV2 =>
  baseEvent({
    capturedAt: NOW,
    tokens: { input: 1_000, output: 100, cacheRead: 500 },
    costUsd: 0.25,
    costSource: "provider",
    ...over,
  });

describe("Overview", () => {
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

  const render = async (events: UsageEventV2[], period: UsageStatsPeriod = 7) => {
    const stats = queryUsageStats(events, period, NOW);
    await act(async () => {
      root.render(createElement(Overview, { events, colors: new Map(), stats, period, now: NOW }));
    });
  };

  const cards = () => [...host.querySelectorAll(".stats__card")];

  it("leads with the period's tokens, cost and session count", async () => {
    await render([usageEvent(), usageEvent({ eventId: "b", sessionId: "other" })]);
    const shown = cards().map((card) => card.textContent);
    // The headline carries what it is MADE of: a bare total hides the split
    // that explains the bill, and cache is usually most of it.
    expect(shown[0]).toBe("Tokens3.2kcache 1k · ↑ 2k · ↓ 200");
    // "≈" because a provider's own figure is an estimate, and the number is
    // a sum of them.
    expect(shown[1]).toBe("Cost≈$0.50");
    expect(shown[2]).toBe("Sessions2");
  });

  it("does not render an unknown cost as a fake zero", async () => {
    // "$0.00" claims the run was free; the truth is that no CLI said.
    await render([usageEvent({ costUsd: undefined, costSource: "unavailable" })]);
    expect(cards()[1].textContent).toBe("Cost—");
    expect(host.textContent).toContain("No CLI reported a cost estimate");
  });

  it("compares the period against the one before it", async () => {
    await render([
      usageEvent(),
      usageEvent({
        eventId: "prior",
        occurredAt: NOW - 8 * DAY,
        tokens: { input: 800 },
      }),
    ]);
    const recap = present(host.querySelector(".stats__recap"), "the .stats__recap element");
    expect(recap.textContent).toContain("+100% vs prior 7d");
    expect(recap.textContent).toContain("busiest day");
  });

  it("keeps the fixed-week history visible when the period itself is empty", async () => {
    // The rolling period and the UTC weeks answer different questions, so an
    // empty 7d must not hide a year of history sitting underneath it.
    await render([usageEvent({ occurredAt: NOW - 400 * DAY })]);
    expect(cards()[0].textContent).toBe("Tokens0");
    expect(host.querySelector(".stats__weeks")).not.toBeNull();
  });

  it("says nothing about a prior period when there is no history to compare", async () => {
    await render([usageEvent()]);
    // The recap must still be THERE — it has a busiest day to report. An
    // assertion that passed on a missing element would also pass on a recap
    // that stopped rendering altogether.
    const recap = present(host.querySelector(".stats__recap"), "the .stats__recap element");
    expect(recap.textContent).toContain("busiest day");
    expect(recap.textContent).not.toContain("vs prior");
  });
});
