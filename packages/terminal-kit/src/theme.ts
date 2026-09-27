import type { ITheme } from "@xterm/xterm";

/**
 * How every terminal in the deck is drawn — the agents' panes and the run
 * log alike, so the two can never disagree on a colour.
 *
 * xterm takes a JS theme object and cannot read CSS custom properties, so the
 * values are written out here; tokens.test.ts holds each one that has a token
 * (the tile, the text, the status hues) to tokens.css. The background is the
 * tile the terminal sits in. The sixteen ANSI colours are tuned for that
 * near-black: the four status hues ARE the status palette, the rest keep
 * xterm's lightness order (black darkest, bright white lightest) so a TUI's
 * own chrome still reads.
 */
export const TERMINAL_THEME: ITheme = {
  background: "#121214",
  foreground: "#d4d4d8",
  cursor: "#ececef",
  cursorAccent: "#121214",
  selectionBackground: "rgba(114, 165, 243, 0.32)",
  black: "#2a2a2f",
  red: "#ef6f6f",
  green: "#4fbf7a",
  yellow: "#e9ae48",
  blue: "#72a5f3",
  magenta: "#c38be8",
  cyan: "#5ec4d1",
  white: "#c9c9cf",
  brightBlack: "#6e6e78",
  brightRed: "#f58f8f",
  brightGreen: "#6fd695",
  brightYellow: "#eec070",
  brightBlue: "#92bbf7",
  brightMagenta: "#d4a8f0",
  brightCyan: "#85d6e0",
  brightWhite: "#ececef",
};

/** The terminal face: the system monospace, the same in every terminal. */
export const TERMINAL_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, monospace";
