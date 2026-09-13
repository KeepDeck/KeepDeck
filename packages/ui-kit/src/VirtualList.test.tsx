// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualList } from "./VirtualList";
import { installResizeObserver, pinListViewport } from "./virtualGeometry.test-support";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 20;
const items = Array.from({ length: 500 }, (_, i) => `row ${i}`);

describe("VirtualList", () => {
  let root: Root;
  let host: HTMLElement;
  let restore: () => void = () => {};

  beforeEach(() => {
    installResizeObserver();
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    restore();
  });

  const render = (onReachEnd?: () => void, list: readonly string[] = items) =>
    act(() =>
      root.render(
        createElement(VirtualList<string>, {
          items: list,
          itemKey: (item) => item,
          estimate: () => ROW,
          render: (item) => createElement("span", { className: "row" }, item),
          className: "list",
          role: "list",
          onReachEnd,
        }),
      ),
    );

  it("mounts only the rows in view and a few beyond, over a spacer the height of all", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    render();
    const rows = host.querySelectorAll(".row");
    // Ten fit the viewport; the overscan adds a handful — never the 500.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.length).toBeLessThan(40);
    expect(rows[0].textContent).toBe("row 0");
    const spacer = host.querySelector(".list > div") as HTMLElement;
    expect(spacer.style.height).toBe(`${500 * ROW}px`);
  });

  it("says when the end is in the window — at once for a list shorter than its viewport", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    const onReachEnd = vi.fn();
    render(onReachEnd, items.slice(0, 5));
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps quiet about the end while it is out of the window", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    const onReachEnd = vi.fn();
    render(onReachEnd);
    expect(onReachEnd).not.toHaveBeenCalled();
  });

  it("is a ul/li list for a consumer whose stylesheet and readers expect one", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    act(() =>
      root.render(
        createElement(VirtualList<string>, {
          items: items.slice(0, 3),
          itemKey: (item) => item,
          estimate: () => ROW,
          render: (item) => createElement("span", { className: "row" }, item),
          className: "list",
          spacer: { as: "ul", className: "list__spacer" },
          item: { as: "li", className: "list__item" },
        }),
      ),
    );
    const spacer = host.querySelector(".list > ul.list__spacer") as HTMLElement;
    expect(spacer).toBeTruthy();
    expect(spacer.style.height).toBe(`${3 * ROW}px`);
    expect(host.querySelectorAll("ul.list__spacer > li.list__item > .row").length).toBe(3);
  });
});
