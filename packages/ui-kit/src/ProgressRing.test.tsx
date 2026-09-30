// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProgressRing } from "./ProgressRing";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProgressRing", () => {
  let root: Root;
  beforeEach(() => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => act(() => root.unmount()));

  const ring = () => document.querySelector<HTMLElement>(".progress-ring")!;

  it("carries its value as the fill the stylesheet animates to", () => {
    act(() => root.render(createElement(ProgressRing, { value: 61 })));
    expect(ring().style.getPropertyValue("--progress-ring-fill")).toBe("61");
    act(() => root.render(createElement(ProgressRing, { value: 12 })));
    expect(ring().style.getPropertyValue("--progress-ring-fill")).toBe("12");
  });

  it("takes a tone near a limit, calm without one, and a site class", () => {
    act(() => root.render(createElement(ProgressRing, { value: 90, tone: "critical", className: "x" })));
    expect(ring().className).toBe("progress-ring progress-ring--critical x");
    act(() => root.render(createElement(ProgressRing, { value: 10, tone: null })));
    expect(ring().className).toBe("progress-ring");
  });

  it("centres a mark when given one, and is decorative", () => {
    act(() => root.render(createElement(ProgressRing, { value: 5 }, createElement("svg"))));
    expect(ring().querySelector(".progress-ring__mark > svg")).not.toBeNull();
    expect(ring().getAttribute("aria-hidden")).toBe("true");
    act(() => root.render(createElement(ProgressRing, { value: 5 })));
    expect(ring().querySelector(".progress-ring__mark")).toBeNull();
  });
});
