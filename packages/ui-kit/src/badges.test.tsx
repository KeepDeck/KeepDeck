// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BranchBadge,
  StoppedMarker,
  TeamBadge,
  YoloBadge,
  YOLO_BADGE_LABEL,
  YOLO_BADGE_TITLE,
  STOPPED_MARKER_TITLE,
  teamBadgeTitle,
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
    it("is an icon-only warn chip naming the mode to assistive tech", () => {
      act(() => root.render(createElement(YoloBadge, {})));
      const badge = host.querySelector<HTMLElement>(".yolo-badge")!;
      expect(badge.className).toBe("chip chip--warn chip--icon-only yolo-badge");
      expect(badge.querySelector(".chip__icon svg")).not.toBeNull();
      expect(badge.querySelector(".chip__label")).toBeNull();
      expect(badge.title).toBe(YOLO_BADGE_TITLE);
      expect(badge.getAttribute("role")).toBe("img");
      expect(badge.getAttribute("aria-label")).toBe(YOLO_BADGE_LABEL);
    });

    it("sizes through the shared anatomy and carries the site hook", () => {
      act(() =>
        root.render(
          createElement(YoloBadge, { size: "sm", className: "minimized__yolo" }),
        ),
      );
      expect(host.querySelector(".yolo-badge")!.className).toBe(
        "chip chip--sm chip--warn chip--icon-only yolo-badge minimized__yolo",
      );
    });

    it("goes decorative inside an already-labeled control", () => {
      act(() => root.render(createElement(YoloBadge, { decorative: true })));
      const badge = host.querySelector<HTMLElement>(".yolo-badge")!;
      expect(badge.getAttribute("aria-hidden")).toBe("true");
      expect(badge.getAttribute("role")).toBeNull();
      expect(badge.getAttribute("aria-label")).toBeNull();
      // The native title stays: it is the only wording a hover gets.
      expect(badge.title).toBe(YOLO_BADGE_TITLE);
    });
  });

  describe("TeamBadge", () => {
    it("shows the ROLE, and keeps the team name for the tooltip", () => {
      // The role is the address teammates use, so it is what a person
      // needs to read a conversation. Where one team runs, its name is the
      // same word under every pane and says nothing on the badge — the
      // tooltip carries it.
      act(() =>
        root.render(createElement(TeamBadge, { team: "api", role: "impl-1" })),
      );
      const chip = host.querySelector<HTMLElement>(".chip")!;
      expect(chip.querySelector(".chip__label")!.textContent).toBe("impl-1");
      expect(chip.title).toBe(teamBadgeTitle("api", "impl-1"));
      expect(chip.title).toContain("api");
      expect(chip.querySelector("svg")).not.toBeNull();
    });

    it("names the team after the role when asked to", () => {
      // Two teams, two leads, and a badge saying `lead` on both — which is
      // where the role stops being an identity. Asked, the badge qualifies
      // it, and the team goes AFTER: clipped by a narrow header the tail is
      // what goes, and a clipped team still tells "api" from "web" while a
      // clipped role would not tell impl-1 from impl-2.
      act(() =>
        root.render(
          createElement(TeamBadge, {
            team: "api",
            role: "lead",
            showTeamName: true,
          }),
        ),
      );
      const label = host.querySelector<HTMLElement>(".chip__label")!;
      expect(label.textContent).toBe("lead · api");
      // The qualifier is dimmed as one piece, separator included — it reads
      // as context for the address, not as a second address.
      expect(label.querySelector(".team-badge__team")!.textContent).toBe(
        " · api",
      );
    });

    it("goes silent for assistive tech inside an already-labelled control", () => {
      act(() =>
        root.render(
          createElement(TeamBadge, { team: "api", role: "lead", decorative: true }),
        ),
      );
      expect(host.querySelector(".chip")!.getAttribute("aria-hidden")).toBe("true");
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

  describe("StoppedMarker", () => {
    it("is a titled bare power glyph carrying only the site hook", () => {
      act(() =>
        root.render(
          createElement(StoppedMarker, { className: "minimized__stopped" }),
        ),
      );
      const marker = host.querySelector<HTMLElement>(".minimized__stopped")!;
      expect(marker.tagName).toBe("SPAN");
      expect(marker.title).toBe(STOPPED_MARKER_TITLE);
      expect(marker.querySelector("svg")).not.toBeNull();
    });
  });
});
