/**
 * Where a terminal's view stands across a program redrawing its history.
 *
 * An agent's TUI that renders into the terminal's own scrollback (kimi on
 * every change above its screen, codex on a resize or a thread switch) wipes
 * the history with `ESC[3J` and prints all of it again. The wipe sends a view
 * scrolled up into the history to its first line, and the reprint, arriving
 * under a view the user scrolled, leaves it there: reading back, the user is
 * thrown to the top. So the line the view stood on is kept at the wipe and
 * returned to once the history is back — clamped to the bottom when it came
 * back shorter, which is a view at the bottom again. A view already at the
 * bottom is left to follow the output, as it does.
 *
 * "Back" is the end of the frame: a program that draws in synchronized
 * frames (`?2026h` … `?2026l`) has reprinted the history when the frame
 * closes; one that never opened a frame has when the write is parsed.
 * A second wipe before the return keeps the first line: the view it finds is
 * the one the first wipe left.
 *
 * Pure: the terminal binding reports what it parsed and scrolls to the line
 * this answers.
 */

/** A terminal's view over its buffer: the first line shown, and that line
 * when the view is at the bottom. */
export interface ScrollView {
  viewportY: number;
  baseY: number;
}

export interface RedrawScroll {
  /** The program wipes the history: `ESC[3J`, seen before it runs. */
  historyCleared(view: ScrollView): void;
  /** The program opened a synchronized frame. */
  frameOpened(): void;
  /** The program closed a synchronized frame: the line to return to, if any. */
  frameClosed(view: ScrollView): number | undefined;
  /** A write was parsed: the line to return to, if any. */
  writeParsed(view: ScrollView): number | undefined;
}

export function createRedrawScroll(): RedrawScroll {
  let drawsFrames = false;
  let anchor: number | undefined;

  const returnTo = (view: ScrollView): number | undefined => {
    if (anchor === undefined) return undefined;
    const line = Math.min(anchor, view.baseY);
    anchor = undefined;
    return line;
  };

  return {
    historyCleared(view) {
      if (anchor === undefined && view.viewportY < view.baseY) anchor = view.viewportY;
    },
    frameOpened() {
      drawsFrames = true;
    },
    frameClosed: returnTo,
    writeParsed: (view) => (drawsFrames ? undefined : returnTo(view)),
  };
}
