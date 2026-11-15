// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { TEST_NOW, usageEvent, type UsageRowOverrides } from "../../domain/usage/history/event.testSupport";
import { ledgerOf } from "../../domain/usage/history/ledger.testSupport";
import type { StatsMeasure } from "../../domain/usage/stats/measure";
import type { StatsPeriod } from "../../domain/usage/stats/period";
import { Overview } from "./Overview";
import { present } from "@keepdeck/plugin-api/testing";

// The chart is loaded lazily and is recharts' business; a stand-in keeps the
// library out of this file and records what the tab handed it.
const chart = vi.hoisted(() => ({ title: null as string | null }));
vi.mock("./UsageChart", () => ({
  UsageChart: ({ view }: { view: { title: string } }) => {
    chart.title = view.title;
    return null;
  },
}));

/** The Overview body maps its views — overviewView and limitsGlanceView,
 * each tested on its own — so the cases here read the markup the reader
 * sees, over a ledger stated in full. */
const NOW = TEST_NOW;
const row = (over: UsageRowOverrides = {}): UsageRow =>
  usageEvent({ occurredAt: NOW - 60_000, capturedAt: NOW, tokens: { input: 1_000, output: 100 }, costUsd: 0.25, ...over });

describe("Overview", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
    chart.title = null;
  });

  afterEach(() => act(() => root.unmount()));

  const render = async (
    events: UsageRow[],
    { period = 7, measure = "spend", accounts = new Map(), onOpenLimits = () => {} }: {
      period?: StatsPeriod;
      measure?: StatsMeasure;
      accounts?: Map<string, AccountUsage>;
      onOpenLimits?: () => void;
    } = {},
  ) => {
    await act(async () => {
      root.render(
        createElement(Overview, {
          ledger: ledgerOf(events),
          period,
          workspace: null,
          measure,
          now: NOW,
          colors: new Map(),
          agentIcons: new Map(),
          accounts,
          reportsByKey: new Map(),
          onOpenLimits,
          onOpenBreakdown: () => {},
        }),
      );
    });
  };

  it("says an empty period in place of the chart and the lists, keeping the card", async () => {
    await render([row({ occurredAt: NOW - 30 * 86_400_000 })]);
    const card = present(host.querySelector(".stats__chart"), "the chart card");
    expect(card.querySelector(".stats__chart-empty")?.textContent).toBe("No usage in 7 days");
    expect(chart.title).toBeNull();
    expect([...host.querySelectorAll(".stats__top-empty")].map((note) => note.textContent)).toContain("No usage in 7 days");

    // Usage with no known price: the card says so instead of empty bars.
    await render([row({ costBasis: "unpriced" })]);
    expect(host.querySelector(".stats__chart-empty")?.textContent).toBe("None of this usage has a known price.");
    expect(chart.title).toBeNull();
  });

  it("counts in tokens when the reader picks them: headline, chart, lists", async () => {
    await render([row({ tokens: { input: 1_000, output: 100, cacheRead: 50_000 } })], { measure: "tokens" });
    const hero = present(host.querySelector(".stats__figure--hero"), "the headline");
    expect(hero.querySelector(".stats__figure-label")?.textContent).toBe("Tokens");
    expect(hero.querySelector(".stats__figure-value")?.textContent).toBe("1.1k");
    expect(chart.title).toBe("Tokens per day");
    expect([...host.querySelectorAll(".stats__top-row b")].map((cell) => cell.textContent)).toContain("1.1k");
  });

  it("leads with the spend and the plain figures beside it", async () => {
    await render([row(), row({ sessionId: "other", workspaceName: "Docs" })]);
    const band = present(host.querySelector(".stats__band"), "the band");
    expect([...band.querySelectorAll(".stats__figure")].map((figure) => figure.textContent)).toEqual([
      "Spent≈$0.50no comparable period before",
      "Sessions2with usage in the period",
      "Output tokens200reasoning included",
    ]);
  });

  it("draws the money over the period and names each agent's share of it", async () => {
    await render([row({ agent: "claude", costUsd: 1 }), row({ agent: "codex", costUsd: 2 })]);
    expect(chart.title).toBe("Spend per day");
    expect(present(host.querySelector(".stats__legend"), "the legend").textContent).toBe("claude≈$1.00codex≈$2.00");
  });

  it("lists where and on what, and opens Limits from the glance", async () => {
    const open = vi.fn();
    await render([row({ workspaceName: "KeepDeck" })], { onOpenLimits: open });
    const lists = [...host.querySelectorAll(".stats__top")];
    expect(lists.map((list) => list.querySelector("h3")?.textContent)).toEqual([
      "WorkspacesBreakdown →",
      "ModelsBreakdown →",
      "Limits nowLimits →",
    ]);
    expect(lists[0]?.textContent).toContain("KeepDeck≈$0.25");
    // No provider has reported in this ledger-only case.
    expect(lists[2]?.textContent).toContain("No provider reports yet.");
    act(() => present(lists[2]?.querySelector("button"), "the Limits door").click());
    expect(open).toHaveBeenCalledOnce();
  });

  it("glances at a reported window with its percent and reset", async () => {
    const accounts = new Map<string, AccountUsage>([
      ["codex", { kind: "reported", reportedAt: NOW - 60_000, sourcePaneId: "pane-1", windows: [
        { usedPct: 37, resetsAt: NOW + 3 * 3_600_000, windowMinutes: 300 },
      ] }],
    ]);
    await render([row()], { accounts });
    const glance = present(host.querySelector(".stats__glance-window"), "a window line");
    expect(glance.textContent).toContain("codex");
    expect(glance.textContent).toContain("37%");
    expect(glance.textContent).toContain("3h");
  });

  it("says an old report's age under the provider's name, never dimmed with a window that reset", async () => {
    const accounts = new Map<string, AccountUsage>([
      ["claude", { kind: "reported", reportedAt: NOW - 3 * 3_600_000, sourcePaneId: "pane-1", windows: [
        { usedPct: 1, resetsAt: NOW + 5 * 86_400_000, windowMinutes: 10_080 },
      ] }],
      ["kimi", { kind: "reported", reportedAt: NOW - 4 * 86_400_000, sourcePaneId: "pane-2", windows: [
        { usedPct: 3, resetsAt: NOW + 3_600_000, windowMinutes: 300 },
        // The week has reset: its line dims, the age in it must not.
        { usedPct: 1, resetsAt: NOW - 3_600_000, windowMinutes: 10_080 },
      ] }],
    ]);
    await render([row()], { accounts });
    const providers = [...host.querySelectorAll(".stats__glance-provider")];
    // The fuller kimi comes first: the glance reads the Limits cards, riskiest first.
    const [kimi, claude] = providers;
    expect([kimi?.textContent?.startsWith("kimi"), claude?.textContent?.startsWith("claude")]).toEqual([true, true]);
    const ageOf = (provider: Element | undefined) => provider?.querySelector(".stats__glance-age");
    // One window: a line of its own under the name.
    expect(ageOf(claude)?.textContent).toBe("3h ago");
    expect(ageOf(claude)?.classList.contains("stats__glance-age--line")).toBe(true);
    // Two windows: the second line's name cell, kept out of the reset window's dimming.
    const kimiLines = [...(kimi?.querySelectorAll(".stats__glance-window") ?? [])];
    expect(kimiLines[1]?.classList.contains("stats__glance-window--expired")).toBe(true);
    expect(kimiLines[1]?.querySelector(".stats__glance-agent--age")?.textContent).toBe("4d ago");
    // Each provider is named by its agent's mark — here the fallback prompt, no mark being known.
    expect(kimi?.querySelector(".stats__glance-agent svg")).not.toBeNull();
    expect(kimi?.querySelector(".stats__glance-agent i")).toBeNull();
    expect(host.textContent).not.toContain("Updated");
  });

  it("says what the money is and what it is missing", async () => {
    await render([row(), row({ costUsd: undefined, tokens: { input: 3_000 } })]);
    expect(present(host.querySelector(".stats__coverage"), "the note").textContent).toContain("a sum marked “+” leaves them out");
    expect(host.querySelector(".stats__figure-value")?.textContent).toBe("≈$0.25+");
  });
});
