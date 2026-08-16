// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

describe("minimized overflow popover", () => {
  it("stretches every chip to the row, so the popover is not a ragged stack", () => {
    // The popover is sized to the WIDEST hidden chip (popoverWidth in
    // MinimizedTray), so a chip keeping its own `width: max-content` lands
    // narrower than its row — the popover showed as many widths as it had
    // entries. The stretch has to beat that base rule through the real
    // cascade: asserting the declaration as text would pass even if
    // `.minimized--chip` still won on specificity.
    const sheet = document.createElement("style");
    sheet.textContent = appCss;
    document.head.append(sheet);
    document.body.innerHTML =
      "<div class='minimized-overflow__list'>" +
      "<button class='minimized minimized--chip'></button>" +
      "</div>";

    const chip = getComputedStyle(document.querySelector(".minimized--chip")!);
    expect(chip.width).toBe("100%");

    sheet.remove();
    document.body.innerHTML = "";
  });
});
