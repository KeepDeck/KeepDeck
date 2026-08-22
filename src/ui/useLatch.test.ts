// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLatch, type Latch } from "./useLatch";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let saving: Latch;
let deleting: Latch;
let renders = 0;
let host: HTMLDivElement;
let root: Root;

function Probe() {
  renders += 1;
  saving = useLatch();
  deleting = useLatch();
  return null;
}

beforeEach(() => {
  renders = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useLatch", () => {
  it("refuses a second acquire IN THE SAME TICK — the property state cannot have", () => {
    // No await and no render between the two calls: this is the exact
    // shape of a double ⌘S, and a state-backed flag would let both
    // through because neither call has re-rendered yet.
    expect(saving.acquire()).toBe(true);
    expect(saving.acquire()).toBe(false);
  });

  it("reads as held synchronously, with no render in between", () => {
    expect(saving.held).toBe(false);
    saving.acquire();
    expect(saving.held).toBe(true);
  });

  it("does not re-render on acquire — it is a guard, not a display", () => {
    // The render-visible twin is deliberately somebody else's job; if
    // taking the latch painted, the two facts would have merged.
    const before = renders;
    saving.acquire();
    expect(renders).toBe(before);
  });

  it("lets the next operation in once released", () => {
    saving.acquire();
    saving.release();
    expect(saving.held).toBe(false);
    expect(saving.acquire()).toBe(true);
  });

  it("survives a re-render still holding", () => {
    // An operation is not released by the component happening to paint
    // during it.
    saving.acquire();
    act(() => root.render(createElement(Probe)));
    expect(saving.held).toBe(true);
    expect(saving.acquire()).toBe(false);
  });

  it("two latches are independent", () => {
    saving.acquire();
    expect(deleting.held).toBe(false);
    expect(deleting.acquire()).toBe(true);
  });
});
