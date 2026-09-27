import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHART_SURFACE } from "../domain/usage/chartPalette";
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
    const ladder = ["--kd-canvas", "--kd-strip", "--kd-tile", "--kd-float", "--kd-hover", "--kd-selected"]
      .map((name) => lightness(declared(tokens, name)));
    ladder.slice(1).forEach((l, i) => expect(l).toBeGreaterThan(ladder[i]));
  });

  it("hold the chart's surface constant to the canvas it is drawn on", () => {
    expect(CHART_SURFACE).toBe(declared(tokens, "--kd-canvas"));
  });
});
