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
  const t = TERMINAL_THEME;
const at = (key: keyof typeof t): string => {
  const value = t[key];
  if (typeof value !== "string") throw new Error(`expected theme ${key} to be a string`);
  return value;
};

  it("keeps the ANSI greys in xterm's lightness order, so TUI chrome still reads", () => {
    const order = [at("background"), at("black"), at("brightBlack"), at("white"), at("brightWhite")].map(luminance);
    order.slice(1).forEach((l, i) => expect(l).toBeGreaterThan(order[i]));
  });

  it("brightens every bright colour above its base", () => {
    const pairs = [
      ["red", "brightRed"],
      ["green", "brightGreen"],
      ["yellow", "brightYellow"],
      ["blue", "brightBlue"],
      ["magenta", "brightMagenta"],
      ["cyan", "brightCyan"],
    ] as const;
    for (const [base, bright] of pairs) {
      expect(luminance(at(bright))).toBeGreaterThan(luminance(at(base)));
    }
  });
});
