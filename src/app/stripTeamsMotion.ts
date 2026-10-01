/**
 * The strip's team-list motion: a list's height and the column's scroll
 * move on ONE curve, frame by frame. Two motions on two clocks (a CSS
 * height transition, a scroll corrected after it) is what made the
 * prototype jump; here the scroll is a function of the same progress as
 * the height, so the row the list hangs from never moves on its own.
 *
 * Impure on purpose and thin: every number it moves to comes from the
 * pure rules in presentation/stripExpand; the clock is injected so tests
 * can step frames.
 */

/** One duration for the strip's every motion — the column's width
 * transition in strip.css is this long too (deck.test holds them equal),
 * so the list and the edge arrive together. */
export const STRIP_MOTION_MS = 140;

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

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ease-out cubic: quick to start, settling at the end. The strip's edge
 * runs the same curve — cubic-bezier(0.33, 1, 0.68, 1) in strip.css, which
 * deck.test holds to this. */
const easeOut = (x: number) => 1 - (1 - x) ** 3;

export interface ListMotion {
  /** The list's own box: its height is driven. */
  block: { style: { height: string } };
  /** The scrolling column: its scrollTop is driven when there is a target. */
  list: { scrollTop: number };
  from: number;
  to: number;
  /** Where the scroll ends, or null to leave the scroll alone. */
  scrollTo: number | null;
  durationMs: number;
}

/** A running motion's two ways out. */
export interface MotionHandle {
  /** Jump to the end at once — a person's own scroll taking over (a script
   * still writing scrollTop under a wheel is a jump). */
  finish(): void;
  /** Stop where it is, without landing or reporting done — a motion the
   * other way takes over from the height it reached. */
  stop(): void;
}

/** Run one list motion. */
export function animateTeamList(
  motion: ListMotion,
  clock: FrameClock,
  onDone?: () => void,
): MotionHandle {
  const { block, list, from, to, scrollTo, durationMs } = motion;
  const scrollFrom = list.scrollTop;
  let frame: number | null = null;
  let done = false;
  const land = (progress: number) => {
    block.style.height = `${from + (to - from) * progress}px`;
    if (scrollTo !== null) list.scrollTop = scrollFrom + (scrollTo - scrollFrom) * progress;
  };
  const finish = () => {
    if (done) return;
    done = true;
    if (frame !== null) clock.cancel(frame);
    land(1);
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
    const progress = Math.min(1, (time - start) / durationMs);
    land(easeOut(progress));
    if (progress < 1) frame = clock.frame(step);
    else finish();
  };
  land(0);
  frame = clock.frame(step);
  return { finish, stop };
}
