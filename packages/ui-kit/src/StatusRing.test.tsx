// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusRing } from "./StatusRing";
import { present } from "@keepdeck/plugin-api/testing";

describe("StatusRing", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the #host element"));
  });
  afterEach(() => act(() => root.unmount()));
  const ring = () => present(document.querySelector<HTMLElement>(".progress-ring"), "the .progress-ring element");

  it("is a ProgressRing pie in the status hue, filled to its place, named for what it says", () => {
    act(() => root.render(createElement(StatusRing, { fill: 75, tone: "waiting", label: "Review" })));
    expect(ring().className).toBe("progress-ring progress-ring--pie status-ring status-ring--waiting");
    expect(ring().style.getPropertyValue("--progress-ring-fill")).toBe("75");
    const box = present(document.querySelector(".status-ring-box"), "the .status-ring-box element");
    expect(box.getAttribute("role")).toBe("img");
    expect(box.getAttribute("aria-label")).toBe("Review");
  });

  it("bars a stopped status, and moves in place — the same element takes the new values", () => {
    act(() => root.render(createElement(StatusRing, { fill: 0, tone: "failed", barred: true, label: "Blocked" })));
    const first = ring();
    expect(first.classList.contains("status-ring--barred")).toBe(true);
    act(() => root.render(createElement(StatusRing, { fill: 50, tone: "working", label: "In progress" })));
    // The same node: its custom properties transition rather than remount.
    expect(ring()).toBe(first);
    expect(first.classList.contains("status-ring--barred")).toBe(false);
    expect(first.style.getPropertyValue("--progress-ring-fill")).toBe("50");
  });

  it("beside its own word, is a picture only — never read twice", () => {
    act(() => root.render(createElement(StatusRing, { fill: 50, tone: "working", label: "In progress", decorative: true })));
    const box = present(document.querySelector(".status-ring-box"), "the .status-ring-box element");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.hasAttribute("role")).toBe(false);
    expect(box.hasAttribute("aria-label")).toBe(false);
  });
});
