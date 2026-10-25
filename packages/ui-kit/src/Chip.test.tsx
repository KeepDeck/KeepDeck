// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chip, type ChipProps } from "./Chip";
import { present } from "@keepdeck/plugin-api/testing";

describe("Chip", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (props: ChipProps = {}) =>
    act(() => root.render(createElement(Chip, props)));

  it("a plain chip is a neutral md span carrying the site's class hook", () => {
    render({ className: "pane__branch" });
    const chip = present(host.querySelector(".chip"), "the .chip element");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.className).toBe("chip pane__branch");
  });

  it("icon and label land in their slots, the icon decorative", () => {
    render({ icon: createElement("svg"), label: "main" });
    const icon = present(host.querySelector(".chip__icon"), "the .chip__icon element");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(present(host.querySelector(".chip__label"), "the .chip__label element").textContent).toBe("main");
  });

  it("tone and size append their modifiers, skipping the defaults", () => {
    render({ tone: "warn", size: "sm", label: "YOLO" });
    expect(present(host.querySelector(".chip"), "the .chip element").className).toBe(
      "chip chip--sm chip--warn",
    );
  });

  it("collapses to the icon-only badge when the glyph is all there is", () => {
    // The shape the YOLO dot and the pane header's activity dot each used to
    // hand-roll in their own sheet: a chip with nothing to say is not a pill,
    // and the side padding would only push its glyph off centre. Derived from
    // the content rather than asked for, so the next icon-only chip cannot
    // forget it and drift into a stadium.
    render({ icon: createElement("svg") });
    expect(present(host.querySelector(".chip"), "the .chip element").className).toBe("chip chip--icon-only");
  });

  it("keeps the pill whenever the chip has something to say", () => {
    // The other half of that derivation, and the one that would break a real
    // site if it went wrong: the usage chip carries its window list through
    // `children`, which is content — squaring it to 22px would crush it.
    render({
      icon: createElement("svg"),
      children: createElement("span", null, "5h"),
    });
    expect(present(host.querySelector(".chip"), "the .chip element").className).toBe("chip");
  });

  it("an onClick chip renders a real button and fires it", () => {
    const onClick = vi.fn();
    render({ onClick, label: "Usage", "aria-expanded": false });
    const chip = present(host.querySelector<HTMLElement>("button.chip"), "the button.chip element");
    expect(chip.getAttribute("type")).toBe("button");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    act(() => chip.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("composite children render raw, without the label wrapper", () => {
    render({
      children: createElement("span", { className: "usage-chip__win" }, "5h"),
    });
    expect(host.querySelector(".chip__label")).toBeNull();
    expect(present(host.querySelector(".usage-chip__win"), "the .usage-chip__win element").textContent).toBe("5h");
  });

  it("extra attributes (title, aria-hidden) reach the root element", () => {
    render({ label: "main", title: "on main", "aria-hidden": true });
    const chip = present(host.querySelector(".chip"), "the .chip element");
    expect(chip.getAttribute("title")).toBe("on main");
    expect(chip.getAttribute("aria-hidden")).toBe("true");
  });
});
