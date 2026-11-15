/**
 * The strip's team-list motion: a list's height and the column's scroll
 * move on ONE curve, frame by frame. Two motions on two clocks (a CSS
 * height transition, a scroll corrected after it) is what made the
 * prototype jump; here the scroll is a function of the same progress as
 * the height, so the row the list hangs from never moves on its own.
 *
 * Impure on purpose and thin: every number it moves to comes from the
 * pure rules in presentation/stripExpand, and the motion itself is ui-kit's
 * one tween (runTween) — the folds' ease-out cubic, which the column's edge
 * runs too as cubic-bezier(0.33, 1, 0.68, 1) in strip.css; the clock is
 * injected so tests can step frames.
 */
import { runTween, type FrameClock, type Tween } from "@keepdeck/ui-kit/tween";

/** One duration for the strip's every motion — the column's width
 * transition in strip.css is this long too (deck.test holds them equal),
 * so the list and the edge arrive together. */
export const STRIP_MOTION_MS = 140;

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

/** A running motion's ways out: the tween's two, and letting the scroll go. */
export interface MotionHandle extends Tween {
  /** Keep moving the height, but stop writing the scroll — another motion
   * now owns the scroll, and two writing it every frame would fight. */
  releaseScroll(): void;
}

/** Run one list motion: the height and the scroll painted from ONE tween. */
export function animateTeamList(
  motion: ListMotion,
  clock: FrameClock,
  onDone?: () => void,
): MotionHandle {
  const { block, list, from, to, scrollTo, durationMs } = motion;
  const scrollFrom = list.scrollTop;
  let scrollTarget = scrollTo;
  const tween = runTween(
    durationMs,
    clock,
    (progress) => {
      block.style.height = `${from + (to - from) * progress}px`;
      if (scrollTarget !== null) list.scrollTop = scrollFrom + (scrollTarget - scrollFrom) * progress;
    },
    onDone,
  );
  return {
    ...tween,
    releaseScroll: () => {
      scrollTarget = null;
    },
  };
}
