// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { TEST_NOW, usageEvent, type UsageRowOverrides } from "../../domain/usage/history/event.testSupport";
import { ledgerOf } from "../../domain/usage/history/ledger.testSupport";
import type { StatsPeriod } from "../../domain/usage/stats/period";
import { Overview } from "./Overview";
import { present } from "@keepdeck/plugin-api/testing";

// The chart is loaded lazily and is recharts' business; a stand-in keeps the
// library out of this file and records what the tab handed it.
const chart = vi.hoisted(() => ({ title: null as string | null }));
vi.mock("./SpendChart", () => ({
  SpendChart: ({ view }: { view: { title: string } }) => {
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
    { period = 7, accounts = new Map(), onOpenLimits = () => {} }: {
      period?: StatsPeriod;
      accounts?: Map<string, AccountUsage>;
      onOpenLimits?: () => void;
    } = {},
  ) => {
    await act(async () => {
      root.render(
        createElement(Overview, {
          ledger: ledgerOf(events),
          period,
          now: NOW,
          colors: new Map(),
          accounts,
          reportsByKey: new Map(),
          onOpenLimits,
        }),
      );
    });
  };

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
    expect(lists.map((list) => list.querySelector("h3")?.textContent)).toEqual(["Workspaces", "Models", "Limits nowLimits →"]);
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

  it("says what the money is and what it is missing", async () => {
    await render([row(), row({ costUsd: undefined, tokens: { input: 3_000 } })]);
    expect(present(host.querySelector(".stats__coverage"), "the note").textContent).toContain("“+” marks a sum");
    expect(host.querySelector(".stats__figure-value")?.textContent).toBe("≈$0.25+");
  });
});
