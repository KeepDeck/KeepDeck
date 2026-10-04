// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useGrowingField } from "./useGrowingField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Field({ value }: { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useGrowingField(ref, value);
  return createElement("textarea", { ref, value, readOnly: true });
}

/** The browser's answers, as a laid-out field gives them: 18px a line at
 * `width` characters a line, 8px padding each side, a 1px border. The
 * scroll height is the content's or the box's, whichever is taller — so a
 * field still standing at an old, taller height reports that height, and
 * only a reset to auto lets it shrink. */
let width = 40;
let observed: (() => void)[] = [];
const lines = (text: string) => text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0);
const boxHeight = (field: HTMLTextAreaElement) => {
  const set = Number.parseFloat(field.style.height);
  return Number.isNaN(set) ? 36 : set;
};

describe("useGrowingField", () => {
  let root: Root;
  beforeEach(() => {
    width = 40;
    Object.defineProperties(HTMLTextAreaElement.prototype, {
      scrollHeight: {
        configurable: true,
        get(this: HTMLTextAreaElement) {
          return Math.max(16 + 18 * lines(this.value), boxHeight(this) - 2);
        },
      },
      offsetHeight: { configurable: true, get(this: HTMLTextAreaElement) { return boxHeight(this); } },
      clientHeight: { configurable: true, get(this: HTMLTextAreaElement) { return boxHeight(this) - 2; } },
      clientWidth: { configurable: true, get: () => width * 8 },
    });
    observed = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private readonly callback: () => void) {}
      observe() {
        observed.push(this.callback);
      }
      disconnect() {}
    };
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    for (const name of ["scrollHeight", "offsetHeight", "clientHeight", "clientWidth"]) {
      delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it("grows a line for each line typed, plus its edges", () => {
    act(() => root.render(createElement(Field, { value: "one" })));
    const field = document.querySelector("textarea")!;
    expect(field.style.height).toBe("36px");
    act(() => root.render(createElement(Field, { value: "one\ntwo\nthree" })));
    expect(field.style.height).toBe("72px");
  });

  it("shrinks back when the text does — a sent draft returns it to one line", () => {
    act(() => root.render(createElement(Field, { value: "one\ntwo\nthree" })));
    const field = document.querySelector("textarea")!;
    expect(field.style.height).toBe("72px");
    act(() => root.render(createElement(Field, { value: "" })));
    expect(field.style.height).toBe("36px");
  });

  it("measures again when its width changes — a wider field wraps fewer lines", () => {
    width = 10;
    const long = "x".repeat(40);
    act(() => root.render(createElement(Field, { value: long })));
    const field = document.querySelector("textarea")!;
    expect(field.style.height).toBe(`${18 + 18 * 4}px`);
    // Expand: the same text now fits one line.
    width = 40;
    act(() => observed.forEach((callback) => callback()));
    expect(field.style.height).toBe("36px");
  });
});
