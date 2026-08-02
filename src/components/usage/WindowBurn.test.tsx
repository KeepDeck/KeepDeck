// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowForecast } from "../../domain/usage/windowForecast";
import { WindowBurn } from "./WindowBurn";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
const forecast = windowForecast(reports, window, NOW);

describe("WindowBurn", () => {
  let root: Root;
  let host: HTMLDivElement;

  const render = (size: ComponentProps<typeof WindowBurn>["size"]) => {
    act(() =>
      root.render(
        createElement(WindowBurn, {
          stroke: "#3987e5",
          window,
          reports,
          forecast,
          now: NOW,
          size,
        }),
      ),
    );
    const plot = host.querySelector<HTMLElement>(".usage-burn__plot")!;
    plot.getBoundingClientRect = () =>
      ({
        top: 100,
        right: 220,
        bottom: size === "card" ? 160 : 120,
        left: 20,
        width: 200,
        height: size === "card" ? 60 : 20,
        x: 20,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    return plot;
  };

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host") as HTMLDivElement;
    root = createRoot(host);
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
      const plot = render(size);

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
    const plot = render("compact");

    act(() => plot.focus());

    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']")!;
    expect(tooltip.dataset.kind).toBe("observed");
    expect(tooltip.textContent).toContain("Observed");
    expect(plot.getAttribute("aria-describedby")).toBe(tooltip.id);

    act(() => plot.blur());
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });
});
