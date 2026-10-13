// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { appCss, px, readStyles, ruleBody } from "./testSupport";

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

describe("notification panel sections", () => {
  it("lets only the feed give way when the panel runs out of height", () => {
    // The panel caps its height and both sections may shrink to zero
    // (min-height 0). A long feed then squeezed the needs section below its
    // own rows, and the feed's head was painted over them. Through the real
    // cascade: the needs section must hold, the feed must stay the one that
    // shrinks.
    const sheet = document.createElement("style");
    sheet.textContent = appCss;
    document.head.append(sheet);
    document.body.innerHTML =
      "<div class='bell__panel'>" +
      "<section class='bell__section bell__section--needs'></section>" +
      "<section class='bell__section bell__section--feed'></section>" +
      "</div>";

    const shrink = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!).flexShrink;
    expect(shrink(".bell__section--needs")).toBe("0");
    expect(shrink(".bell__section--feed")).toBe("1");

    sheet.remove();
    document.body.innerHTML = "";
  });
});
