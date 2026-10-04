// @vitest-environment happy-dom
import { act, cloneElement, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_BAR_RADIUS } from "../../domain/usage/chartPalette";
import { TEST_NOW, usageEvent } from "../../domain/usage/history/event.testSupport";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom lays nothing out, so the responsive box would measure 0×0 and
// draw no chart: the box hands the chart a fixed size, as a laid-out one
// would. Nothing else of recharts is replaced.
vi.mock("recharts", async (original) => {
  const actual = await original<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 200 }),
  };
});

let UsageChart: typeof import("./UsageChart").UsageChart;
beforeAll(async () => {
  ({ UsageChart } = await import("./UsageChart"));
}, 60_000);

const DAY = 24 * 60 * 60 * 1_000;
const events = [
  usageEvent({ occurredAt: TEST_NOW - 2 * DAY, agent: "claude", tokens: { input: 900 } }),
  // A sliver of a second agent on top: the case a per-segment cap got wrong.
  usageEvent({ occurredAt: TEST_NOW - 2 * DAY, agent: "codex", tokens: { input: 10 } }),
  usageEvent({ occurredAt: TEST_NOW - DAY, agent: "claude", tokens: { input: 500 } }),
];

describe("UsageChart", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const clips = () => [...document.querySelectorAll("clipPath")].map((clip) => clip.id).filter((id) => id.includes("bar-stack"));

  it("rounds each column as one stack — its segments cut by one shape", () => {
    act(() => root.render(createElement(UsageChart, { events, period: 7, now: TEST_NOW })));
    expect(document.querySelector(".recharts-bar-rectangle")).not.toBeNull();
    expect(clips().length).toBeGreaterThan(0);
    // The stack's shape: its two top corners arcs of the cap radius, its
    // foot square — whatever segment is on top.
    for (const shape of document.querySelectorAll("clipPath[id*='bar-stack'] path")) {
      const d = shape.getAttribute("d") ?? "";
      expect(d.match(new RegExp(`A ${CHART_BAR_RADIUS},${CHART_BAR_RADIUS}`, "g"))).toHaveLength(2);
    }
  });

  it("names its stacks apart from another chart's, so neither clips by the other's shapes", () => {
    act(() =>
      root.render(
        createElement("div", null, [
          createElement(UsageChart, { key: "a", events, period: 7, now: TEST_NOW }),
          createElement(UsageChart, { key: "b", events, period: 7, now: TEST_NOW }),
        ]),
      ),
    );
    const ids = clips();
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
