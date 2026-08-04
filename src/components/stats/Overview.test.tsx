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

/** The Overview body: headline numbers, the recap sentence, the coverage
 * disclaimer and the period-independent Weeks block. It takes the queried
 * stats as a prop, so the cases here state a ledger and let the domain
 * answer — no dialog, no tab, no mocked hooks. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const render = (events: UsageEventV2[], period: UsageStatsPeriod = 7) => {
    const stats = queryUsageStats(events, period, NOW);
    act(() =>
      root.render(createElement(Overview, { events, stats, period, now: NOW })),
    );
  };

  const cards = () => [...host.querySelectorAll(".stats__card")];

  it("leads with the period's tokens, cost and session count", () => {
    render([usageEvent(), usageEvent({ eventId: "b", sessionId: "other" })]);
    const shown = cards().map((card) => card.textContent);
    expect(shown[0]).toBe("Tokens3.2k");
    // "≈" because a provider's own figure is an estimate, and the number is
    // a sum of them.
    expect(shown[1]).toBe("Cost≈$0.50");
    expect(shown[2]).toBe("Sessions2");
  });

  it("does not render an unknown cost as a fake zero", () => {
    // "$0.00" claims the run was free; the truth is that no CLI said.
    render([usageEvent({ costUsd: undefined, costSource: "unavailable" })]);
    expect(cards()[1].textContent).toBe("Cost—");
    expect(host.textContent).toContain("No CLI reported a cost estimate");
  });

  it("compares the period against the one before it", () => {
    render([
      usageEvent(),
      usageEvent({
        eventId: "prior",
        occurredAt: NOW - 8 * DAY,
        tokens: { input: 800 },
      }),
    ]);
    const recap = host.querySelector(".stats__recap")!;
    expect(recap.textContent).toContain("+100% vs prior 7d");
    expect(recap.textContent).toContain("busiest day");
  });

  it("keeps the fixed-week history visible when the period itself is empty", () => {
    // The rolling period and the UTC weeks answer different questions, so an
    // empty 7d must not hide a year of history sitting underneath it.
    render([usageEvent({ occurredAt: NOW - 400 * DAY })]);
    expect(cards()[0].textContent).toBe("Tokens0");
    expect(host.querySelector(".stats__weeks")).not.toBeNull();
  });

  it("says nothing about a prior period when there is no history to compare", () => {
    render([usageEvent()]);
    const recap = host.querySelector(".stats__recap");
    expect(recap?.textContent ?? "").not.toContain("vs prior");
  });
});
