// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowForecast } from "../../domain/usage/windowForecast";
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

  const render = (
    size: ComponentProps<typeof WindowBurn>["size"],
    overrides: Partial<ComponentProps<typeof WindowBurn>> = {},
  ) => {
    const nextWindow = overrides.window ?? window;
    const nextReports = overrides.reports ?? reports;
    const nextNow = overrides.now ?? NOW;
    act(() =>
      root.render(
        createElement(WindowBurn, {
          stroke: "#3987e5",
          window: nextWindow,
          reports: nextReports,
          forecast:
            overrides.forecast ??
            windowForecast(nextReports, nextWindow, nextNow),
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
      expect(tooltip.textContent).toContain("UTC");
      expect(plot.querySelector(".usage-burn__cursor")).not.toBeNull();
      expect(plot.querySelector(".usage-burn__dot--active")).not.toBeNull();

      act(() =>
        plot.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
      );
      expect(document.querySelector("[role='tooltip']")).toBeNull();
    },
  );

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
