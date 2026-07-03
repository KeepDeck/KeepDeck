// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { collectRailItemRects } from "./railDnd";

describe("collectRailItemRects (real DOM)", () => {
  it("reads id + vertical extent from [data-ws-id] children, in order", () => {
    document.body.innerHTML = `
      <ul id="list">
        <li data-ws-id="ws-1"></li>
        <li class="rail__item" data-ws-id="ws-2"></li>
        <li>no id — skipped</li>
      </ul>`;
    const list = document.getElementById("list")!;
    const rects = collectRailItemRects(list);
    expect(rects.map((r) => r.id)).toEqual(["ws-1", "ws-2"]);
    // happy-dom returns 0-rects, but the shape (top/bottom numbers) must hold.
    for (const r of rects) {
      expect(typeof r.top).toBe("number");
      expect(typeof r.bottom).toBe("number");
    }
  });
});
