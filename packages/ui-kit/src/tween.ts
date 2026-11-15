import { easeFold } from "./foldMotion";

/**
 * THE eased motion a fold drawn by hand runs on: one progress from 0 to 1
 * on the folds' curve (easeFold), frame by frame from an injected clock.
 * The strip's team lists and FoldBlock both paint from it — a height, and
 * the strip's scroll on the very same progress. What is painted is the
 * caller's; when, and how far along, is this. (useFoldMotion's clock is its
 * own: it runs many folds that start apart and merge mid-flight.)
 */

/** Where the frames come from — the browser's, or a test's stepped one. */
export interface FrameClock {
  now(): number;
  frame(callback: (time: number) => void): number;
  cancel(id: number): void;
}

export const browserClock: FrameClock = {
  now: () => performance.now(),
  frame: (callback) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : window.setTimeout(() => callback(performance.now()), 16),
  cancel: (id) =>
    typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : window.clearTimeout(id),
};

/** The media query of the person's ask for reduced motion. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the person asked for reduced motion: a motion then lands at once. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION).matches === true;
}

/** A running motion's two ways out. */
export interface Tween {
  /** Land at once, and say so — the person's own scroll taking over. */
  finish(): void;
  /** Stop where it is, neither landing nor saying so — a motion the other
   * way takes over from what this one reached. */
  stop(): void;
}

/**
 * Run one motion: `paint` is handed the eased progress at once (0), on
 * every frame, and at the end (1); `onDone` follows the end, once. With
 * no duration it lands at once — reduced motion.
 */
export function runTween(
  durationMs: number,
  clock: FrameClock,
  paint: (progress: number) => void,
  onDone?: () => void,
): Tween {
  let frame: number | null = null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (frame !== null) clock.cancel(frame);
    paint(1);
    onDone?.();
  };
  const stop = () => {
    if (done) return;
    done = true;
    if (frame !== null) clock.cancel(frame);
  };
  if (durationMs <= 0) {
    finish();
    return { finish, stop };
  }
  const start = clock.now();
  const step = (time: number) => {
    frame = null;
    if (done) return;
    const progress = easeFold((time - start) / durationMs);
    if (progress >= 1) {
      finish();
      return;
    }
    paint(progress);
    frame = clock.frame(step);
  };
  paint(0);
  frame = clock.frame(step);
  return { finish, stop };
}
