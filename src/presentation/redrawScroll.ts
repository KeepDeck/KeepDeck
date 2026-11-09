/**
 * Where a terminal's view stands across a program redrawing its history.
 *
 * An agent's TUI that renders into the terminal's own scrollback (kimi on
 * every change above its screen, codex on a resize or a thread switch) wipes
 * the history with `ESC[3J` and prints it again. The wipe sends a view
 * scrolled up into the history to its first line, and the reprint, arriving
 * under a view the user scrolled, leaves it there: reading back, the user is
 * thrown to the top. So where the view stood is kept at the wipe and returned
 * to once the history is back. A view already at the bottom is left to follow
 * the output, as it does.
 *
 * Where it stood depends on what came back. A history at least as long kept
 * its head — kimi reprints all of it, anything new below — so the view
 * returns to the same line, and new output does not move what is read. One
 * that came back shorter lost lines from its head — codex, after a resize,
 * reprints only the newest rows — so the view keeps its distance from the
 * bottom, and stops at the first line left when it read further back.
 *
 * "Back" is the end of a frame: a program that draws in synchronized frames
 * (`?2026h` … `?2026l`) has reprinted the history when the first frame to
 * close after the wipe does — kimi wipes inside that frame, codex just ahead
 * of it; one that never opened a frame has when the write is parsed.
 * A second wipe before the return keeps the first view: the one it finds is
 * what the first wipe left.
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
  /** The view the wipe found, kept until it is returned to. */
  let anchor: ScrollView | undefined;

  const returnTo = (view: ScrollView): number | undefined => {
    if (anchor === undefined) return undefined;
    const { viewportY, baseY } = anchor;
    anchor = undefined;
    return view.baseY >= baseY ? viewportY : Math.max(0, view.baseY - (baseY - viewportY));
  };

  return {
    historyCleared(view) {
      if (anchor === undefined && view.viewportY < view.baseY) anchor = { ...view };
    },
    frameOpened() {
      drawsFrames = true;
    },
    frameClosed: returnTo,
    writeParsed: (view) => (drawsFrames ? undefined : returnTo(view)),
  };
}
