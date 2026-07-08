// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { collectRailItemRects } from "./railDnd";

function rect(top: number): DOMRect {
  return {
    bottom: top,
    height: 0,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("collectRailItemRects (real DOM)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads id + layout extent from [data-ws-id] children, in order", () => {
    document.body.innerHTML = `
      <ul id="list">
        <li data-ws-id="ws-1"></li>
        <li class="rail__item" data-ws-id="ws-2"></li>
        <li>no id — skipped</li>
      </ul>`;
    const list = document.getElementById("list")!;
    const items = [...list.querySelectorAll<HTMLElement>("[data-ws-id]")];
    list.getBoundingClientRect = () => rect(100);
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 5 });
    Object.defineProperty(items[0], "offsetTop", { configurable: true, value: 10 });
    Object.defineProperty(items[0], "offsetHeight", {
      configurable: true,
      value: 30,
    });
    Object.defineProperty(items[1], "offsetTop", { configurable: true, value: 42 });
    Object.defineProperty(items[1], "offsetHeight", {
      configurable: true,
      value: 30,
    });
    const rects = collectRailItemRects(list);
    expect(rects).toEqual([
      { id: "ws-1", top: 105, bottom: 135 },
      { id: "ws-2", top: 137, bottom: 167 },
    ]);
  });

  it("ignores visual transforms so FLIP animation does not corrupt hit-testing", () => {
    document.body.innerHTML = `
      <ul id="list">
        <li data-ws-id="ws-1" style="transform: translateY(500px)"></li>
      </ul>`;
    const list = document.getElementById("list")!;
    const item = list.querySelector<HTMLElement>("[data-ws-id]")!;
    list.getBoundingClientRect = () => rect(20);
    Object.defineProperty(item, "offsetTop", { configurable: true, value: 10 });
    Object.defineProperty(item, "offsetHeight", {
      configurable: true,
      value: 30,
    });
    item.getBoundingClientRect = () => rect(520);

    expect(collectRailItemRects(list)).toEqual([
      { id: "ws-1", top: 30, bottom: 60 },
    ]);
  });
});
