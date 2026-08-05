// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowReport } from "../../domain/usage/reportJournal";
import type { UsageWindow } from "../../domain/usage/usage";
import { windowBurn } from "../../domain/usage/windowBurn";
import {
  burnEdgeLabel,
  windowForecast,
  type WindowForecast,
} from "../../domain/usage/windowForecast";
import { WindowBurn } from "./WindowBurn";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

  /** The surface computes the geometry now — the card's caption reads the
   * same object — so the test assembles it the way a surface would. */
  const render = (
    size: ComponentProps<typeof WindowBurn>["size"],
    overrides: {
      window?: UsageWindow;
      reports?: readonly WindowReport[];
      now?: number;
      forecast?: WindowForecast;
      edge?: ComponentProps<typeof WindowBurn>["edge"];
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
          geometry: windowBurn(
            nextReports,
            nextWindow,
            forecast,
            nextNow,
            size === "card" ? "limit" : "data",
          ),
          edge: overrides.edge ?? burnEdgeLabel(nextWindow, forecast, nextNow),
          now: nextNow,
          size,
        }),
      ),
    );
    const plot = host.querySelector<HTMLElement>(".usage-burn__plot");
    if (plot === null) return null;
    plot.getBoundingClientRect = () =>
      ({
        top: plotTop,
        right: plotLeft + 200,
        bottom: plotTop + (size === "card" ? 60 : 20),
        left: plotLeft,
        width: 200,
        height: size === "card" ? 60 : 20,
        x: plotLeft,
        y: plotTop,
        toJSON: () => ({}),
      }) as DOMRect;
    return plot;
  };

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host") as HTMLDivElement;
    root = createRoot(host);
    plotLeft = 20;
    plotTop = 100;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it.each([
    ["card", 22, "Observed"],
    ["compact", 180, "Projected"],
  ] as const)(
    "inspects the %s curve with the shared portaled tooltip",
    (size, clientX, expectedKind) => {
      const plot = render(size)!;

      act(() =>
        plot.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX,
            clientY: 115,
          }),
        ),
      );

      const tooltip = document.querySelector<HTMLElement>("[role='tooltip']")!;
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

  it("labels the card's ceiling as the limit, and only on the card", () => {
    // The frame's top IS 100% now. If this ever went back to reading a
    // field off the geometry — an easy slip after `yMaxPct` became
    // `endPct` — the label would follow the data again and quietly
    // reintroduce the wrong-scale bug on every surviving window.
    render("card");
    expect(host.querySelector(".usage-burn__ymax")!.textContent).toBe("100%");
  });

  it("gives the compact plot no ceiling or floor label to contradict", () => {
    // Which is exactly why its scale is the data's rather than the limit's:
    // there is nothing on it disclosing what the frame means.
    render("compact");
    expect(host.querySelector(".usage-burn__ymax")).toBeNull();
    expect(host.querySelector(".usage-burn__foot")).toBeNull();
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
    const plot = render("compact", {
      reports: quiet,
      window: { ...window, usedPct: 10 },
    })!;
    const points = plot
      .querySelector("polyline")!
      .getAttribute("points")!
      .split(" ")
      .map((pair) => Number(pair.split(",")[1]));
    // The floor of a 20px plot with PAD 2 is y=18.
    for (const y of points) expect(y).toBeLessThan(16);
  });

  it("exposes the latest observed value immediately on keyboard focus", () => {
    const plot = render("compact")!;

    act(() => plot.focus());

    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']")!;
    expect(tooltip.dataset.kind).toBe("observed");
    expect(tooltip.textContent).toContain("Observed");
    expect(plot.getAttribute("aria-describedby")).toBe(tooltip.id);

    act(() => plot.blur());
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("rederives an open inspection when geometry updates", () => {
    const plot = render("compact")!;
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
    render("compact", {
      window: nextWindow,
      reports: nextReports,
      now: later,
    });

    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "80%",
    );
  });

  it("discards inspection state while geometry is unavailable", () => {
    const plot = render("compact")!;
    act(() => plot.focus());
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();

    expect(render("compact", { reports: reports.slice(-1) })).toBeNull();
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    expect(render("compact", { reports: reports.slice(-2) })).not.toBeNull();
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("keeps inspection open while either hover or focus remains", () => {
    const plot = render("compact")!;
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
    const plot = render("compact")!;
    act(() => plot.focus());
    const initialLeft =
      document.querySelector<HTMLElement>("[role='tooltip']")!.style.left;

    plotLeft = 80;
    act(() => globalThis.window.dispatchEvent(new Event("scroll")));

    expect(
      document.querySelector<HTMLElement>("[role='tooltip']")!.style.left,
    ).not.toBe(initialLeft);
  });
});
