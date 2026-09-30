// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BranchBadge,
  YoloBadge,
  YOLO_BADGE_LABEL,
  YOLO_BADGE_TITLE,
} from "./badges";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("badges", () => {
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

  describe("YoloBadge", () => {
    it("is the bare bolt — no chip — naming the mode to assistive tech", () => {
      act(() => root.render(createElement(YoloBadge, {})));
      const mark = host.querySelector<HTMLElement>(".yolo-mark")!;
      expect(mark.className).toBe("yolo-mark");
      // Not a ringed chip any more: a glyph among the header's glyphs.
      expect(mark.classList.contains("chip")).toBe(false);
      expect(mark.querySelector("svg")).not.toBeNull();
      expect(mark.title).toBe(YOLO_BADGE_TITLE);
      expect(mark.getAttribute("role")).toBe("img");
      expect(mark.getAttribute("aria-label")).toBe(YOLO_BADGE_LABEL);
    });

    it("takes the small size and the site hook", () => {
      act(() =>
        root.render(
          createElement(YoloBadge, { size: "sm", className: "minimized__yolo" }),
        ),
      );
      expect(host.querySelector(".yolo-mark")!.className).toBe(
        "yolo-mark yolo-mark--sm minimized__yolo",
      );
    });

    it("goes decorative inside an already-labeled control", () => {
      act(() => root.render(createElement(YoloBadge, { decorative: true })));
      const badge = host.querySelector<HTMLElement>(".yolo-mark")!;
      expect(badge.getAttribute("aria-hidden")).toBe("true");
      expect(badge.getAttribute("role")).toBeNull();
      expect(badge.getAttribute("aria-label")).toBeNull();
      // The native title stays: it is the only wording a hover gets.
      expect(badge.title).toBe(YOLO_BADGE_TITLE);
    });
  });

  describe("BranchBadge", () => {
    it("renders the branch glyph and label with the tooltip wording", () => {
      act(() =>
        root.render(
          createElement(BranchBadge, {
            label: "main",
            title: "on main",
            className: "pane__branch",
          }),
        ),
      );
      const badge = host.querySelector<HTMLElement>(".chip")!;
      // No own anatomy class: the site hook passes through untouched.
      expect(badge.className).toBe("chip pane__branch");
      expect(badge.querySelector(".chip__icon svg")).not.toBeNull();
      expect(badge.querySelector(".chip__label")!.textContent).toBe("main");
      expect(badge.title).toBe("on main");
      // Standalone = self-naming: never aria-hidden unless the site asks.
      expect(badge.getAttribute("aria-hidden")).toBeNull();
    });

    it("omits the tooltip and names itself decorative when the site asks", () => {
      act(() =>
        root.render(
          createElement(BranchBadge, {
            label: "kd/KeepDeck/8",
            size: "sm",
            decorative: true,
          }),
        ),
      );
      const badge = host.querySelector<HTMLElement>(".chip")!;
      expect(badge.className).toBe("chip chip--sm");
      expect(badge.title).toBe("");
      expect(badge.getAttribute("aria-hidden")).toBe("true");
    });
  });

});
