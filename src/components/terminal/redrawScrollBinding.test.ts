// @vitest-environment happy-dom
/**
 * The binding against the installed xterm, fed what the agents send: kimi's
 * frame (`?2026h ESC[2J ESC[H ESC[3J`, the whole history, `?2026l`), codex's
 * wipe ahead of the frame that reprints the newest rows, and a program that
 * draws no frames. What is checked is the line the reader sees on top.
 */
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { registerRedrawScroll } from "./redrawScrollBinding";

afterEach(() => {
  document.body.innerHTML = "";
});

const ROWS = 10;
const lines = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => `line ${from + n}\r\n`).join("");
const HISTORY = lines(0, 100);
const WIPE = "\x1b[2J\x1b[H\x1b[3J";
const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";

function openTerminal(): Terminal {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new Terminal({ rows: ROWS, cols: 40, scrollback: 1000 });
  term.open(host);
  return term;
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** A terminal with the history printed and the view scrolled up to `line n` on top. */
async function readingAt(line: number): Promise<Terminal> {
  const term = openTerminal();
  await write(term, HISTORY);
  term.scrollToLine(line);
  return term;
}

/** The line the reader sees on top. */
const topLine = (term: Terminal) =>
  term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true);

describe("a view scrolled up while the agent redraws its history", () => {
  it("is sent to the first line by the installed xterm on its own", async () => {
    const term = await readingAt(30);

    await write(term, OPEN + WIPE + HISTORY + CLOSE);

    expect(topLine(term)).toBe("line 0");
    term.dispose();
  });

  it("stays on its line through kimi's frame, new output below it, xterm still wiping the history it reprints", async () => {
    const term = await readingAt(30);
    const baseY = term.buffer.active.baseY;
    const binding = registerRedrawScroll(term);

    await write(term, OPEN + WIPE + HISTORY + lines(100, 102) + CLOSE);

    expect(topLine(term)).toBe("line 30");
    expect(term.buffer.active.baseY).toBe(baseY + 2);
    binding.dispose();
    term.dispose();
  });

  it("stays on its line when codex wipes ahead of the frame and reprints only the newest rows, over several writes", async () => {
    const term = await readingAt(60);
    const binding = registerRedrawScroll(term);
    await write(term, OPEN + "status" + CLOSE);

    await write(term, WIPE);
    await write(term, OPEN + lines(50, 75));
    await write(term, lines(75, 100) + CLOSE);

    expect(topLine(term)).toBe("line 60");
    binding.dispose();
    term.dispose();
  });

  it("stays on its line when a program that draws no frames reprints in one write", async () => {
    const term = await readingAt(30);
    const binding = registerRedrawScroll(term);

    await write(term, WIPE + HISTORY);

    expect(topLine(term)).toBe("line 30");
    binding.dispose();
    term.dispose();
  });
});

describe("a view at the bottom while the agent redraws its history", () => {
  it("follows the output down", async () => {
    const term = openTerminal();
    await write(term, HISTORY);
    const binding = registerRedrawScroll(term);

    await write(term, OPEN + WIPE + HISTORY + lines(100, 101) + CLOSE);

    const buffer = term.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY);
    binding.dispose();
    term.dispose();
  });
});
