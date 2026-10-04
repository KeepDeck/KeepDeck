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

describe("useGrowingField", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  it("stands as tall as its content plus its edges, measured again as the text changes", () => {
    // The browser's answers happy-dom does not compute: 18px a line, 2px of
    // border outside the client box.
    const lines = (text: string) => Math.max(1, text.split("\n").length);
    Object.defineProperties(HTMLTextAreaElement.prototype, {
      scrollHeight: { configurable: true, get(this: HTMLTextAreaElement) { return 16 + 18 * lines(this.value); } },
      offsetHeight: { configurable: true, get: () => 36 },
      clientHeight: { configurable: true, get: () => 34 },
    });
    try {
      act(() => root.render(createElement(Field, { value: "one" })));
      const field = document.querySelector("textarea")!;
      expect(field.style.height).toBe("36px");
      act(() => root.render(createElement(Field, { value: "one\ntwo\nthree" })));
      expect(field.style.height).toBe("72px");
    } finally {
      for (const name of ["scrollHeight", "offsetHeight", "clientHeight"]) {
        delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });
});
