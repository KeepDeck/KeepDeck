// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowReport } from "../../domain/usage/reportJournal";
import type { UsageWindow } from "../../domain/usage/usage";
import { windowBurn } from "../../domain/usage/windowBurn";
import { windowForecast, type WindowForecast } from "../../domain/usage/windowForecast";
import { WindowBurn } from "./WindowBurn";
import { present } from "@keepdeck/plugin-api/testing";
import { instanceOf } from "../../testing/values.test-support";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const MIN = 60_000;
const window = {
  usedPct: 62,
  resetsAt: NOW + 155 * MIN,
  windowMinutes: 300,
};
const reports: WindowReport[] = [50.4, 53.3, 56.2, 59.1, 62].map(
  (usedPct, index) => ({
    agent: "claude",
    windowMinutes: 300,
    usedPct,
    reportedAt: NOW - (4 - index) * 10 * MIN,
    resetsAt: window.resetsAt,
  }),
);
describe("WindowBurn", () => {
  let root: Root;
  let host: HTMLDivElement;
  let plotLeft: number;
  let plotTop: number;

  /** The surface computes the geometry, so the test assembles it the way
   * the popover does. */
  const render = (
    overrides: {
      window?: UsageWindow;
      reports?: readonly WindowReport[];
      now?: number;
      forecast?: WindowForecast;
    } = {},
  ) => {
    const nextWindow = overrides.window ?? window;
    const nextReports = overrides.reports ?? reports;
    const nextNow = overrides.now ?? NOW;
    const forecast =
      overrides.forecast ?? windowForecast(nextReports, nextWindow, nextNow);
    act(() =>
      root.render(
        createElement(WindowBurn, {
          stroke: "#3987e5",
          geometry: windowBurn(nextReports, nextWindow, forecast, nextNow),
          now: nextNow,
        }),
      ),
    );
    const plot = host.querySelector<HTMLElement>(".usage-burn__plot");
    if (plot === null) return null;
    plot.getBoundingClientRect = () =>
      ({
        top: plotTop,
        right: plotLeft + 200,
        bottom: plotTop + 20,
        left: plotLeft,
        width: 200,
        height: 20,
        x: plotLeft,
        y: plotTop,
        toJSON: () => ({}),
      });
    return plot;
  };

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = instanceOf(document.getElementById("host"), HTMLDivElement, "host");
    root = createRoot(host);
    plotLeft = 20;
    plotTop = 100;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it.each([
    [22, "Observed"],
    [180, "Projected"],
  ] as const)(
    "inspects the curve at %spx with the shared portaled tooltip",
    (clientX, expectedKind) => {
      const plot = present(render(), "the rendered output");

      act(() =>
        plot.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX,
            clientY: 115,
          }),
        ),
      );

      const tooltip = present(document.querySelector<HTMLElement>("[role='tooltip']"), "the [role='tooltip'] element");
      expect(tooltip.parentElement).toBe(document.body);
      expect(tooltip.dataset.kind).toBe(expectedKind.toLowerCase());
      expect(tooltip.textContent).toContain(expectedKind);
      expect(tooltip.textContent).toContain("% used");
      // The SAME clock the edge label under the plot speaks. It used to go
      // through the UTC bucket formatter, so one widget named one moment in
      // two timezones — half-hour offsets made that a visible contradiction.
      expect(tooltip.textContent).toMatch(/\d{2}:\d{2}/);
      expect(tooltip.textContent).not.toContain("UTC");
      expect(plot.querySelector(".usage-burn__cursor")).not.toBeNull();
      expect(plot.querySelector(".usage-burn__dot--active")).not.toBeNull();

      act(() =>
        plot.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
      );
      expect(document.querySelector("[role='tooltip']")).toBeNull();
    },
  );

  it("gives the sparkline no ceiling or floor label to contradict", () => {
    // Which is exactly why its scale is the data's rather than the limit's:
    // there is nothing on it disclosing what the frame means.
    render();
    expect(host.querySelector(".usage-burn")?.textContent).toBe("");
  });

  it("ends the pointer's inspection when the page scrolls — the card does not stay behind", () => {
    const plot = present(render(), "the rendered output");
    act(() => plot.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 115 })));
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();
    act(() => globalThis.window.dispatchEvent(new Event("scroll")));
    expect(document.querySelector("[role='tooltip']")).toBeNull();
    // Focus's inspection stays through a scroll, and follows the plot.
    act(() => plot.focus());
    act(() => globalThis.window.dispatchEvent(new Event("scroll")));
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();
  });

  it("walks the inspection with the arrow keys from the newest reading", () => {
    const plot = present(render(), "the rendered output");
    act(() => plot.focus());
    const first = document.querySelector("[role='tooltip']")?.textContent;
    act(() => plot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const moved = present(document.querySelector<HTMLElement>("[role='tooltip']"), "the tooltip");
    // One step right of the newest reading is the projection — and it is
    // read aloud, not only drawn.
    expect(moved.dataset.kind).toBe("projected");
    expect(moved.textContent).not.toBe(first);
    expect(host.querySelector("[role='status']")?.textContent).toMatch(/Projected, \d+% used$/);
    act(() => plot.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("keeps a quiet window off its own axis line in the 20px sparkline", () => {
    // The popover is 20px tall with 2px of padding: on the limit scale a
    // 10%-used window sat 1.6px above the floor grid line, inside the two
    // strokes' combined width, and the curve vanished into the axis.
    const quiet = [10, 10, 10, 10, 10].map((usedPct, index) => ({
      agent: "claude",
      windowMinutes: 300,
      usedPct,
      reportedAt: NOW - (4 - index) * 10 * MIN,
      resetsAt: window.resetsAt,
    }));
    const plot = present(render({
      reports: quiet,
      window: { ...window, usedPct: 10 },
    }), "the rendered output");
    const points = present(present(plot
      .querySelector("polyline"), "the polyline element")
      .getAttribute("points"), "the polyline element")
      .split(" ")
      .map((pair) => Number(pair.split(",")[1]));
    // The floor of a 20px plot with PAD 2 is y=18.
    for (const y of points) expect(y).toBeLessThan(16);
  });

  it("exposes the latest observed value immediately on keyboard focus", () => {
    const plot = present(render(), "the rendered output");

    act(() => plot.focus());

    const tooltip = present(document.querySelector<HTMLElement>("[role='tooltip']"), "the [role='tooltip'] element");
    expect(tooltip.dataset.kind).toBe("observed");
    expect(tooltip.textContent).toContain("Observed");
    expect(plot.getAttribute("aria-describedby")).toBe(tooltip.id);

    act(() => plot.blur());
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("rederives an open inspection when geometry updates", () => {
    const plot = present(render(), "the rendered output");
    act(() => plot.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "62%",
    );

    const later = NOW + 10 * MIN;
    const nextWindow = { ...window, usedPct: 80 };
    const nextReports = [
      ...reports,
      {
        ...reports[reports.length - 1],
        usedPct: 80,
        reportedAt: later,
      },
    ];
    render({
      window: nextWindow,
      reports: nextReports,
      now: later,
    });

    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "80%",
    );
  });

  it("discards inspection state while geometry is unavailable", () => {
    const plot = present(render(), "the rendered output");
    act(() => plot.focus());
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();

    expect(render({ reports: reports.slice(-1) })).toBeNull();
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    expect(render({ reports: reports.slice(-2) })).not.toBeNull();
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("keeps inspection open while either hover or focus remains", () => {
    const plot = present(render(), "the rendered output");
    act(() => {
      plot.focus();
      plot.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 100,
          clientY: 115,
        }),
      );
    });

    act(() =>
      plot.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
    );
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();

    act(() => {
      plot.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 100,
          clientY: 115,
        }),
      );
      plot.blur();
    });
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();

    act(() =>
      plot.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
    );
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("remeasures a focused plot when an ancestor scrolls", () => {
    const plot = present(render(), "the rendered output");
    act(() => plot.focus());
    const initialLeft =
      present(document.querySelector<HTMLElement>("[role='tooltip']"), "the [role='tooltip'] element").style.left;

    plotLeft = 80;
    act(() => globalThis.window.dispatchEvent(new Event("scroll")));

    expect(
      present(document.querySelector<HTMLElement>("[role='tooltip']"), "the [role='tooltip'] element").style.left,
    ).not.toBe(initialLeft);
  });
});
