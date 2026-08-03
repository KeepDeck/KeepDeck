// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YoloBadge } from "../ui/badges";
import { STYLES_DIR, appCss, stripComments } from "./testSupport";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The declarations of ONE flat rule, by selector. Deliberately `[^{}]*` for the
 * body: a rule that ever gains nesting stops matching and this fails loudly,
 * rather than a looser scan quietly reading the wrong half of it. `from` lets a
 * caller pick the copy inside a container query over the base rule above it.
 */
function ruleBody(
  css: string,
  selector: string,
  from = 0,
): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(
    css.slice(from),
  );
  expect(match, `no flat rule for ${selector}`).not.toBeNull();
  return Object.fromEntries(
    match![1]
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [
          declaration.slice(0, colon).trim(),
          declaration.slice(colon + 1).trim(),
        ];
      }),
  );
}

const read = (file: string) =>
  stripComments(readFileSync(join(STYLES_DIR, file), "utf8"));

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
    for (const [size, diameter] of [
      [undefined, "22px"],
      ["sm", "20px"],
    ] as const) {
      act(() => root.render(createElement(YoloBadge, { size })));
      const badge = getComputedStyle(host.querySelector(".yolo-badge")!);
      expect(badge.width, `${size ?? "md"} width`).toBe(diameter);
      expect(badge.height, `${size ?? "md"} height`).toBe(diameter);
      expect(badge.paddingLeft).toBe("0px");
      expect(badge.paddingRight).toBe("0px");
      expect(badge.justifyContent).toBe("center");
      expect(badge.borderRadius).toBe("999px");
    }
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
    const canonical = ruleBody(read("chip.css"), ".chip--icon-only");
    // Non-vacuous, and says what the value MEANS: the diameter is the chip's
    // own height, which is what makes the radius draw a circle.
    expect(canonical.width).toBe("22px");

    const paneCss = read("pane.css");
    const narrowHeader = paneCss.indexOf("@container (max-width: 280px)");
    expect(narrowHeader, "the narrow-header query is gone").toBeGreaterThan(-1);

    expect(ruleBody(paneCss, ".pane__branch", narrowHeader)).toEqual(canonical);
  });
});
