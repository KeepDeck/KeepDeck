// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollExit } from "./useScrollExit";

let root: Root;
afterEach(() => act(() => root.unmount()));

function Probe({ active, onExit }: { active: boolean; onExit(): void }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useScrollExit(active, ref, onExit);
  return createElement("span", { ref }, "the anchor");
}

function render(active: boolean, onExit: () => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe, { active, onExit })));
  return host;
}

/** A dialog's own scroller: its scroll does not bubble to the window. */
const scrollInside = (host: Element) => {
  const scroller = document.createElement("div");
  host.appendChild(scroller);
  act(() => scroller.dispatchEvent(new Event("scroll", { bubbles: false })));
};

describe("useScrollExit", () => {
  it("calls the exit when anything scrolls while the cursor's tip is pending or up — a nested scroller too", () => {
    const onExit = vi.fn();
    const host = render(true, onExit);
    scrollInside(host);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("listens to nothing while no tip of the cursor's is pending or up", () => {
    const onExit = vi.fn();
    const host = render(false, onExit);
    scrollInside(host);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(onExit).not.toHaveBeenCalled();
  });
});
