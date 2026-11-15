// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoldBlock } from "./FoldBlock";
import { FOLD_MOTION_MS } from "./useFoldMotion";
import { FakeMediaQueryList } from "./testDom.test-support";
import { present } from "@keepdeck/plugin-api/testing";

/** The rows' own height: happy-dom lays nothing out, so the block says it. */
const ROWS = 60;
const rows = (...names: string[]): ReactNode => names.map((name) => createElement("p", { key: name }, name));

describe("FoldBlock", () => {
  let root: Root;
  let host: HTMLElement;
  const original = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    window.matchMedia = original;
    vi.useRealTimers();
  });

  const draw = (open: boolean, children: ReactNode) =>
    act(() => root.render(createElement(FoldBlock, { open, role: "rowgroup", children })));
  const block = () => {
    const element = present(host.querySelector<HTMLElement>("[role='rowgroup']"), "the block");
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => ROWS });
    return element;
  };
  const frames = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const height = () => parseFloat(block().style.height);
  const names = () => [...host.querySelectorAll("p")].map((row) => row.textContent);

  it("draws its first state still, and at rest leaves the height to its rows", () => {
    draw(true, rows("a", "b"));
    expect(names()).toEqual(["a", "b"]);
    expect(block().style.height).toBe("");
    expect(block().style.overflow).toBe("");
  });

  it("unrolls the rows from under the heading, on the fold's clock, then lets them be", () => {
    draw(false, null);
    block();
    draw(true, rows("a", "b"));
    // Drawn shut before the first paint, clipped while it moves.
    expect(height()).toBe(0);
    expect(block().style.overflow).toBe("hidden");
    frames(FOLD_MOTION_MS / 2);
    // Eased out: past half the rows by half the time, not yet all of them.
    expect(height()).toBeGreaterThan(ROWS / 2);
    expect(height()).toBeLessThan(ROWS);
    frames(FOLD_MOTION_MS);
    expect(block().style.height).toBe("");
    expect(block().style.overflow).toBe("");
  });

  it("rolls up the rows it was last given, inert, though the owner lists none once shut", () => {
    draw(true, rows("a", "b"));
    block();
    draw(false, null);
    expect(names()).toEqual(["a", "b"]);
    expect(block().inert).toBe(true);
    expect(height()).toBe(ROWS);
    frames(FOLD_MOTION_MS / 2);
    expect(height()).toBeLessThan(ROWS / 2);
    frames(FOLD_MOTION_MS);
    expect(names()).toEqual([]);
    expect(block().inert).toBe(false);
    expect(block().style.height).toBe("");
  });

  it("turned round midway, goes on from the height it reached", () => {
    draw(false, null);
    block();
    draw(true, rows("a"));
    frames(FOLD_MOTION_MS / 4);
    const reached = height();
    expect(reached).toBeGreaterThan(0);
    draw(false, null);
    // No jump back to the rows' full height: it rolls up from where it was.
    expect(height()).toBe(reached);
    expect(names()).toEqual(["a"]);
    frames(FOLD_MOTION_MS + 40);
    expect(names()).toEqual([]);
  });

  it("lands every fold at once under reduced motion", () => {
    window.matchMedia = (query) => new FakeMediaQueryList(query, query.includes("reduce"));
    draw(true, rows("a"));
    block();
    draw(false, null);
    expect(names()).toEqual([]);
    expect(block().style.height).toBe("");
    draw(true, rows("a"));
    expect(names()).toEqual(["a"]);
    expect(block().style.height).toBe("");
  });
});
