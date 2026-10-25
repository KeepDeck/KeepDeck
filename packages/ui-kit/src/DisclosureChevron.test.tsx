// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DisclosureChevron } from "./DisclosureChevron";
import { present } from "@keepdeck/plugin-api/testing";

describe("DisclosureChevron", () => {
  it("is one drawn mark, turned by its open class, kept from assistive tech", () => {
    document.body.innerHTML = "<div id='host'></div>";
    const root = createRoot(present(document.getElementById("host"), "the #host element"));
    act(() => root.render(createElement(DisclosureChevron, { open: false })));
    const mark = present(document.querySelector(".kd-chevron"), "the .kd-chevron element");
    expect(mark.className).toBe("kd-chevron");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("svg")).not.toBeNull();
    act(() => root.render(createElement(DisclosureChevron, { open: true })));
    // The same node: the turn transitions rather than remounts.
    expect(document.querySelector(".kd-chevron")).toBe(mark);
    expect(mark.className).toBe("kd-chevron kd-chevron--open");
    act(() => root.unmount());
  });
});
