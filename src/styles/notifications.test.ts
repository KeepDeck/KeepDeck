import { describe, expect, it } from "vitest";
import { px, readStyles, ruleBody } from "./testSupport";

const notifications = readStyles("notifications.css");

describe("notification center rows", () => {
  it("keeps every leading visual in one title-aligned slot", () => {
    const item = ruleBody(notifications, ".bell__item");
    expect(item.display).toBe("grid");
    expect(item["grid-template-columns"]).toBe(
      "16px minmax(0, 1fr) auto",
    );
    expect(item["align-items"]).toBe("start");

    const leading = ruleBody(notifications, ".bell__leading");
    expect(px(leading.width)).toBe(16);
    expect(px(leading.height)).toBe(16);
    expect(leading.display).toBe("grid");
    expect(leading["place-items"]).toBe("center");

    expect(px(ruleBody(notifications, ".bell__item-title")["line-height"]))
      .toBe(16);
  });
});
