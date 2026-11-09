import type { IDisposable, Terminal } from "@xterm/xterm";
import { createRedrawScroll, type ScrollView } from "../../presentation/redrawScroll";

/** DEC private mode 2026: synchronized output, a program's frame. */
const SYNCHRONIZED_OUTPUT = 2026;
/** `ESC[3J`: erase in display, the saved lines — the history. */
const ERASE_SAVED_LINES = 3;

/**
 * Keep a terminal's view on its line while the program inside redraws its
 * history (`presentation/redrawScroll`). Reports the wipe, the frames, each
 * parsed write and each key to it, and scrolls where it answers. Every
 * handler declines the sequence, so xterm still runs its own.
 */
export function registerRedrawScroll(term: Terminal): IDisposable {
  const scroll = createRedrawScroll();
  const view = (): ScrollView => {
    const buffer = term.buffer.active;
    return { viewportY: buffer.viewportY, baseY: buffer.baseY };
  };
  const returnTo = (line: number | undefined): void => {
    if (line !== undefined) term.scrollToLine(line);
  };

  const hooks = [
    term.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === ERASE_SAVED_LINES) scroll.historyCleared(view());
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(SYNCHRONIZED_OUTPUT)) scroll.frameOpened();
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(SYNCHRONIZED_OUTPUT)) returnTo(scroll.frameClosed(view()));
      return false;
    }),
    term.onWriteParsed(() => returnTo(scroll.writeParsed(view()))),
    term.onKey(() => scroll.keyPressed()),
  ];
  return { dispose: () => hooks.forEach((hook) => hook.dispose()) };
}
