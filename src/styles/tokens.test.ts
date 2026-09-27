import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_THEME } from "@keepdeck/terminal-kit";
import * as chart from "../domain/usage/chartPalette";
import { readStyles, STYLES_DIR } from "./testSupport";

/**
 * tokens.css is the one home of the chrome's colours. These hold the promises
 * that make that true: it loads before anything that reads it, the status
 * names every surface paints with resolve to its one palette, and the copies
 * that cannot say `var()` stay equal to it.
 */

const tokens = readStyles("tokens.css");

function declared(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`${name} is not declared`);
  return match[1].trim();
}

/** WCAG 2 contrast ratio of two sRGB hexes. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab lightness of an sRGB hex — the scale on which "a step the eye can
 * see" is measured. */
function lightness(hex: string): number {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617963 * m - 0.0040720468 * s;
}

describe("the design tokens", () => {
  it("load before every stylesheet that reads them", () => {
    const index = readFileSync(join(STYLES_DIR, "index.css"), "utf8");
    const imports = [...index.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports[0]).toBe("./tokens.css");
  });

  it("give every agent-status name a hue from the one status palette", () => {
    const status = readStyles("status.css");
    expect(declared(status, "--status-working")).toBe("var(--kd-working)");
    expect(declared(status, "--status-waiting")).toBe("var(--kd-warn)");
    expect(declared(status, "--status-failed")).toBe("var(--kd-err)");
    expect(declared(status, "--status-done")).toBe("var(--kd-ok)");
    expect(declared(tokens, "--kd-info")).toBe("var(--kd-working)");
  });

  it("keep hover and the seam a step apart the eye can see", () => {
    // The old pair (#1b2230 hover, #1c2230 seam) differed by 0.001 — the
    // same colour twice. 0.03 is a comfortably visible step on near-black.
    const hover = lightness(declared(tokens, "--kd-hover"));
    const seam = lightness(declared(tokens, "--kd-seam"));
    expect(seam - hover).toBeGreaterThanOrEqual(0.03);
  });

  it("step every surface lighter than the one it sits on", () => {
    const ladder = ["--kd-canvas", "--kd-strip", "--kd-tile", "--kd-float", "--kd-hover", "--kd-selected", "--kd-seam", "--kd-seam-strong"]
      .map((name) => lightness(declared(tokens, name)));
    ladder.slice(1).forEach((l, i) => expect(l).toBeGreaterThan(ladder[i]));
  });

  it("set the UI in the bundled Inter, falling back to the system face", () => {
    expect(declared(tokens, "--kd-font-ui")).toMatch(/^"Inter Variable",\s*ui-sans-serif/);
    expect(declared(readStyles("base.css"), "font-family")).toBe("var(--kd-font-ui)");
    const app = readFileSync(join(STYLES_DIR, "..", "App.tsx"), "utf8");
    expect(app).toContain('import "@fontsource-variable/inter";');
  });

  it("keep --kd-text-3, the floor for readable text, readable on a tile and a hover", () => {
    const text3 = declared(tokens, "--kd-text-3");
    expect(contrast(text3, declared(tokens, "--kd-tile"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text3, declared(tokens, "--kd-hover"))).toBeGreaterThanOrEqual(4);
  });

  it("paint every terminal on the tile, in the status palette's hues", () => {
    expect(TERMINAL_THEME.background).toBe(declared(tokens, "--kd-tile"));
    expect(TERMINAL_THEME.cursor).toBe(declared(tokens, "--kd-text"));
    expect(TERMINAL_THEME.red).toBe(declared(tokens, "--kd-err"));
    expect(TERMINAL_THEME.green).toBe(declared(tokens, "--kd-ok"));
    expect(TERMINAL_THEME.yellow).toBe(declared(tokens, "--kd-warn"));
    expect(TERMINAL_THEME.blue).toBe(declared(tokens, "--kd-working"));
    expect(TERMINAL_THEME.brightRed).toBe(declared(tokens, "--kd-err-strong"));
    expect(TERMINAL_THEME.brightGreen).toBe(declared(tokens, "--kd-ok-strong"));
    expect(TERMINAL_THEME.brightYellow).toBe(declared(tokens, "--kd-warn-strong"));
  });

  it("open the native window on the canvas, so launch shows no second colour", () => {
    const conf = JSON.parse(readFileSync(join(STYLES_DIR, "..", "..", "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.app.windows[0].backgroundColor).toBe(declared(tokens, "--kd-canvas"));
  });

  it("hold the chart's surface constant to the canvas it is drawn on", () => {
    expect(chart.CHART_SURFACE).toBe(declared(tokens, "--kd-canvas"));
  });

  it("draw the chart's chrome in the chrome's tokens", () => {
    const pairs: [string, string][] = [
      [chart.CHART_GRID, "--kd-hover"],
      [chart.CHART_AXIS, "--kd-seam"],
      [chart.CHART_TICK_INK, "--kd-text-4"],
      [chart.CHART_LEGEND_INK, "--kd-text-3"],
      [chart.CHART_ITEM_INK, "--kd-text-2"],
      [chart.CHART_LABEL_INK, "--kd-text-4"],
      [chart.CHART_TOOLTIP_BG, "--kd-float"],
      [chart.CHART_TOOLTIP_BORDER, "--kd-seam"],
    ];
    for (const [value, token] of pairs) expect(value).toBe(declared(tokens, token));
  });
});
