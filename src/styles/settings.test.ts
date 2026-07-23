// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES_DIR = "src/styles";
const stylesIndex = readFileSync(join(STYLES_DIR, "index.css"), "utf8");
const appCss = [...stylesIndex.matchAll(/@import\s+"([^"]+)"\s*;/g)]
  .map((match) =>
    readFileSync(join(STYLES_DIR, match[1].replace(/^\.\//, "")), "utf8"),
  )
  .join("\n");

/**
 * happy-dom drops min()/calc() width and height declarations. Preserve those
 * values as custom properties instead: its real selector engine then decides
 * the winner across the app's actual stylesheet order, including specificity
 * and !important, without this test implementing a partial CSS cascade.
 */
function trackDimensions(css: string): string {
  return css.replace(
    /(^|[;{])(\s*)(width|height)(\s*:)/gm,
    "$1$2--settings-test-$3$4",
  );
}

function mountLayout(extraCss = "") {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 800 },
    innerHeight: { configurable: true, value: 500 },
  });
  const source = document.createElement("style");
  source.textContent = `${trackDimensions(appCss)}\n${extraCss}`;
  document.head.append(source);

  const surface = document.createElement("div");
  surface.className = "form settings";
  const body = document.createElement("div");
  body.className = "settings__body";
  const nav = document.createElement("nav");
  nav.className = "settings__nav";
  const section = document.createElement("section");
  section.className = "settings__section";
  body.append(nav, section);
  surface.append(body);
  document.body.append(surface);

  return {
    surface,
    body,
    nav,
    section,
    cleanup() {
      surface.remove();
      source.remove();
    },
  };
}

/**
 * The Settings surface deliberately uses one exact contract:
 * min(fixed cap, viewport - gutter). Parse that narrow shape, then verify its
 * used value instead of merely accepting any positive subtraction.
 */
function viewportBound(
  value: string,
  axis: "w" | "h",
  viewport: number,
): number {
  const compact = value.replace(/\s+/g, "");
  const match = compact.match(
    new RegExp(
      `^min\\((\\d+(?:\\.\\d+)?)px,calc\\(100v${axis}-(\\d+(?:\\.\\d+)?)px\\)\\)$`,
    ),
  );
  expect(match, `invalid viewport bound: ${value}`).not.toBeNull();
  const cap = Number(match![1]);
  const gutter = Number(match![2]);
  expect(cap).toBeGreaterThan(0);
  expect(gutter).toBeGreaterThan(0);
  expect(gutter).toBeLessThan(viewport);
  const used = Math.min(cap, viewport - gutter);
  expect(used).toBeGreaterThan(0);
  expect(used).toBeLessThan(viewport);
  return used;
}

describe("Settings layout", () => {
  it("bounds the whole surface at the minimum supported viewport", () => {
    const layout = mountLayout();
    try {
      const surface = getComputedStyle(layout.surface);
      expect(surface.boxSizing).toBe("border-box");
      expect(surface.maxWidth).toBe("none");
      expect(
        viewportBound(
          surface.getPropertyValue("--settings-test-width"),
          "w",
          window.innerWidth,
        ),
      ).toBe(768);
      expect(
        viewportBound(
          surface.getPropertyValue("--settings-test-height"),
          "h",
          window.innerHeight,
        ),
      ).toBe(468);

      const body = getComputedStyle(layout.body);
      expect(body.flexGrow).toBe("1");
      expect(body.flexShrink).toBe("1");
      expect(body.flexBasis).toBe("0%");
      expect(Number.parseFloat(body.minHeight)).toBe(0);
      expect(body.gridTemplateRows).toBe("minmax(0, 1fr)");
    } finally {
      layout.cleanup();
    }
  });

  it("keeps non-zero breathing room in both scroll owners", () => {
    const layout = mountLayout();
    try {
      for (const element of [layout.nav, layout.section]) {
        const declarations = getComputedStyle(element);
        expect(Number.parseFloat(declarations.minHeight)).toBe(0);
        expect(declarations.overflowY).toBe("auto");
        expect(Number.parseFloat(declarations.paddingRight)).toBeGreaterThan(0);
        expect(Number.parseFloat(declarations.paddingBottom)).toBeGreaterThan(0);
      }
    } finally {
      layout.cleanup();
    }
  });

  it("uses the browser cascade for specificity and important overrides", () => {
    for (const extraCss of [
      `
        .settings .settings__section { overflow-y: visible; }
        .settings__section { overflow-y: scroll; }
      `,
      `
        .settings__section { overflow-y: visible !important; }
        .settings__section { overflow-y: scroll; }
      `,
    ]) {
      const layout = mountLayout(extraCss);
      try {
        expect(getComputedStyle(layout.section).overflowY).toBe("visible");
      } finally {
        layout.cleanup();
      }
    }
  });
});
