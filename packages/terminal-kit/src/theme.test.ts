import { describe, expect, it } from "vitest";
import { TERMINAL_THEME } from "./theme";

/** Relative luminance — enough to compare two colours' brightness. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("the terminal theme", () => {
  const t = TERMINAL_THEME as Record<string, string>;

  it("keeps the ANSI greys in xterm's lightness order, so TUI chrome still reads", () => {
    const order = [t.background, t.black, t.brightBlack, t.white, t.brightWhite].map(luminance);
    order.slice(1).forEach((l, i) => expect(l).toBeGreaterThan(order[i]));
  });

  it("brightens every bright colour above its base", () => {
    for (const name of ["red", "green", "yellow", "blue", "magenta", "cyan"]) {
      const bright = `bright${name[0].toUpperCase()}${name.slice(1)}`;
      expect(luminance(t[bright])).toBeGreaterThan(luminance(t[name]));
    }
  });
});
