// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Peek, type PeekProps } from "./Peek";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Peek", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (props: Partial<PeekProps> = {}) => {
    const full: PeekProps = {
      ariaLabel: "Diff of app.ts",
      name: "app.ts",
      scrollKey: "a.ts",
      onClose: vi.fn(),
      children: "content",
      ...props,
    };
    return act(() => root.render(createElement(Peek, full)));
  };

  const body = () => host.querySelector<HTMLElement>(".peek__body")!;

  /** The reader is deep into a long file, and off to the side of a wide one. */
  const scrollAway = () => {
    body().scrollTop = 640;
    body().scrollLeft = 120;
  };

  it("a new content identity puts the body back at the top, both axes", () => {
    render();
    scrollAway();
    render({ scrollKey: "b.ts", name: "b.ts", children: "other content" });
    expect(body().scrollTop).toBe(0);
    expect(body().scrollLeft).toBe(0);
  });

  it("re-rendering the same content leaves the reader where they were", () => {
    render();
    scrollAway();
    // Same key, different children — a load step landing, or a watcher
    // refresh re-reading the file the reader is halfway through.
    render({ children: "content, refreshed" });
    expect(body().scrollTop).toBe(640);
    expect(body().scrollLeft).toBe(120);
  });

  it("the body outlives its content, keeping focus across a change", () => {
    render();
    const before = body();
    expect(document.activeElement).toBe(before);

    render({ scrollKey: "b.ts", children: "other content" });

    // The same node, not a remount — which is precisely why resetting the
    // scroll has to be explicit, and why the focus that makes PageUp/PageDown
    // work is not re-established per file.
    expect(body()).toBe(before);
    expect(document.activeElement).toBe(before);
  });
});
