// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YoloBadge } from "../ui/badges";
import { AgentPaneHeader } from "../components/agent/AgentPaneHeader";
import { appCss, readStyles, ruleBody } from "./testSupport";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = appCss;
  document.head.append(sheet);
  document.body.innerHTML = "<div id='host'></div>";
  host = document.getElementById("host")!;
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  sheet.remove();
});

describe("icon-only chip", () => {
  it("draws a real circle at both sizes", () => {
    // Through the shipped component and the shipped stylesheet, because the
    // bug being kept out is a chip that LOOKS like a badge in markup and lands
    // as a stadium on screen: a 999px radius only reads as a circle while the
    // box is square, which means the side padding must be gone and the width
    // must equal the chip's own height.
    // Square is asserted as width === height rather than against a literal:
    // repeating 22 and 20 here is what --chip-diameter exists to stop, and a
    // literal would fail on a density change with a message that reads like a
    // stale expectation, inviting the number to be updated instead of the bug
    // to be found.
    const seen = new Set<string>();
    for (const size of [undefined, "sm"] as const) {
      act(() => root.render(createElement(YoloBadge, { size })));
      const badge = getComputedStyle(host.querySelector(".yolo-badge")!);
      const label = size ?? "md";
      expect(badge.width, `${label} has no width`).toMatch(/^\d+px$/);
      expect(badge.height, `${label} is not square`).toBe(badge.width);
      expect(badge.paddingLeft).toBe("0px");
      expect(badge.paddingRight).toBe("0px");
      expect(badge.justifyContent).toBe("center");
      expect(badge.borderRadius).toBe("999px");
      seen.add(badge.width);
    }
    // Both sizes really resolved — one token feeding both would otherwise let
    // `sm` silently stop being smaller while every assertion above passed.
    expect(seen.size, "md and sm draw the same diameter").toBe(2);
  });

  it("rounds the pane header's activity dot through the same shape", () => {
    // The second chip that is icon-only by nature. pane.css used to square it
    // by hand and now declares only its flex place and font size, so this dot
    // is round ONLY if the derivation reaches it — and if that call site ever
    // gained a label, every existing test would stay green: the header's own
    // tests assert `className` with `toContain` and mount no stylesheet at all.
    // So it is asserted here, off the shipped header, through the shipped CSS.
    act(() =>
      root.render(
        createElement(AgentPaneHeader, {
          paneId: "pane-1",
          title: "Claude 1",
          keyboardFocusEnabled: true,
          focused: false,
          solo: false,
          activityView: {
            tone: "working",
            label: "Working",
            sentence: "working",
            at: 1_754_000_000_000,
          },
          now: 1_754_000_000_000,
          ctxPct: undefined,
          paneLive: true,
          onRename: () => {},
          onToggleFocus: () => {},
          onClose: () => {},
        }),
      ),
    );

    const dot = getComputedStyle(host.querySelector(".pane__activity")!);
    expect(dot.width).toBe("22px");
    expect(dot.height).toBe("22px");
    expect(dot.paddingLeft).toBe("0px");
    expect(dot.justifyContent).toBe("center");
  });

  it("holds the narrow pane header's copy of the shape to the original", () => {
    // The one place that restates the shape instead of wearing the class. Its
    // icon-only state is conditional — the branch badge sheds its label only
    // while the pane header is too narrow for it — and that call belongs to a
    // container query, which can set an element's properties but cannot give
    // it a class, with no CSS way to apply another rule's block either.
    //
    // So the copy is deliberate and this is what makes it safe: it is checked
    // against the original rather than trusted. Source, not cascade, because
    // happy-dom does not evaluate @container at all — verified, not assumed:
    // a probe stylesheet's queried declarations never reached getComputedStyle.
    const chipCss = readStyles("chip.css");
    const canonical = ruleBody(chipCss, ".chip--icon-only");
    // Non-vacuous, and says what the value MEANS rather than repeating a
    // number: the badge's width IS the chip's height, which is the whole
    // reason a 999px radius draws a circle here instead of a stadium.
    expect(canonical.width).toBe(ruleBody(chipCss, ".chip").height);

    const paneCss = readStyles("pane.css");
    const narrowHeader = paneCss.indexOf("(max-width: 355px)");
    expect(narrowHeader, "the narrow-header query is gone").toBeGreaterThan(-1);

    expect(ruleBody(paneCss, ".pane__branch", narrowHeader)).toEqual(canonical);
  });
});
