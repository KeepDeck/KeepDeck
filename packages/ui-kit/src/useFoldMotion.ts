import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import {
  easeFold,
  foldFrame,
  reachable,
  segmentsOf,
  walkAt,
  type FoldFrame,
  type FoldSegment,
  type Layout,
} from "./foldMotion";

/** How long a fold takes, start to end. */
export const FOLD_MOTION_MS = 160;

/** One fold in flight: where the rows changed, the rows that left (to
 * draw as ghosts), how far along it is, and the person's scroll walk. */
interface Motion<T> {
  segments: readonly FoldSegment[];
  ghosts: ReadonlyMap<string, T>;
  startedAt: number | null;
  residual: number;
  /** The walk the fold's hold asked for: from where the scroll stood to
   * where the hold put the folded heading. */
  walk: { from: number; to: number } | null;
  /** The scroll this clock last wrote — a different one is the person's. */
  written: number | null;
  /** The person took the scroll: the walk writes no more. */
  released: boolean;
}

export interface FoldMotionInput<T> {
  items: readonly T[];
  /** This render is a change the person made (`easeKey` with the items). */
  eased: boolean;
  /** The layout as it stands now — final, the virtualizer's — read only
   * when a fold needs it. */
  readLayout(): Layout;
  /** Whether this list folds at all (it has an `easeKey`): only then is
   * the layout kept from one render to the next. */
  folds: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  /** How far beyond the view rows are mounted, in pixels. */
  overscan: number;
}

export interface FoldMotion<T> {
  /** What to draw this render, or null when nothing is moving. */
  frame: FoldFrame | null;
  /** A ghost's item, by key. */
  ghost(key: string): T | undefined;
  /** For the hold: take the scroll walk instead of writing it. True when
   * a fold is in flight to walk it. */
  takeWalk(from: number, to: number): boolean;
  /** For any other write of the scroll during a fold (the anchoring's
   * compensation for someone else's change): the walk moves with it. */
  shifted(by: number): void;
  /** End the fold now — before a write the fold must not race (a reveal). */
  settle(): void;
}

/**
 * The fold's clock — the one place a person's fold is played out over
 * time (`foldMotion` says where everything is at a moment; this says
 * which moment it is). A change the person made starts a motion from the
 * layout as it was last drawn to the layout as it is now; every animation
 * frame the clock moves it on and draws the list once more, and walks the
 * scroll the fold's hold asked for — unless the person scrolls, which
 * always wins. Reduced motion: no motion at all, the fold lands at once.
 *
 * The layout itself is never animated: the virtualizer, its measurements
 * and the anchoring see only final rows.
 */
export function useFoldMotion<T>({ items, eased, readLayout, folds, scrollRef, overscan }: FoldMotionInput<T>): FoldMotion<T> {
  const [, draw] = useReducer((n: number) => n + 1, 0);
  const motion = useRef<Motion<T> | null>(null);
  // The layout and items last drawn — the "before" of the next fold.
  const drawn = useRef<{ items: readonly T[]; layout: Layout } | null>(null);
  // The change a motion was made for — a second render of it makes none.
  const madeFor = useRef<readonly T[] | null>(null);

  // The layout of this render, read once, when a fold is made or painted.
  let now: Layout | null = null;
  const layoutNow = () => (now ??= readLayout());
  if (eased && madeFor.current !== items && drawn.current !== null && !reducedMotion()) {
    const layout = layoutNow();
    madeFor.current = items;
    const segments = segmentsOf(drawn.current.layout, layout);
    if (segments !== null && segments.length > 0) {
      // A fold in flight is overtaken: its scroll lands where it was going.
      finishWalk(motion.current, scrollRef.current);
      const left = new Set(segments.flatMap((segment) => segment.ghosts.map((ghost) => ghost.key)));
      const keyOf = new Map(drawn.current.layout.rows.map((row, index) => [row.key, index]));
      const ghosts = new Map<string, T>();
      for (const key of left) {
        const index = keyOf.get(key);
        if (index !== undefined) ghosts.set(key, drawn.current.items[index]);
      }
      motion.current = { segments, ghosts, startedAt: null, residual: 1, walk: null, written: null, released: false };
    }
  }

  // What this render drew is the "before" of the next fold — kept only
  // by a list that folds, and only in its own copy.
  useLayoutEffect(() => {
    if (folds) drawn.current = { items, layout: layoutNow() };
  });

  // The clock: one frame at a time while a motion lasts.
  const running = motion.current;
  useEffect(() => {
    if (!running) return;
    const list = scrollRef.current;
    const release = () => {
      running.released = true;
    };
    const events = ["wheel", "touchstart", "pointerdown"] as const;
    for (const name of events) list?.addEventListener(name, release, { passive: true });
    let frameId = 0;
    const tick = (now: number) => {
      if (motion.current !== running) return;
      running.startedAt ??= now;
      const eased = easeFold((now - running.startedAt) / FOLD_MOTION_MS);
      running.residual = 1 - eased;
      walkTo(running, list, eased);
      if (eased >= 1) motion.current = null;
      draw();
      if (motion.current === running) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
      for (const name of events) list?.removeEventListener(name, release);
    };
  }, [running, scrollRef]);

  const current = motion.current;
  // During a fold, which rows to mount is decided by where they are
  // DRAWN — so the scroll box is read here, the one time a render asks.
  const list = scrollRef.current;
  const frame = current
    ? foldFrame(current.segments, layoutNow(), current.residual, {
        top: list?.scrollTop ?? 0,
        height: list?.clientHeight ?? 0,
        overscan,
      })
    : null;

  const takeWalk = useCallback(
    (from: number, to: number) => {
      const live = motion.current;
      const box = scrollRef.current;
      if (!live || !box) return false;
      live.walk = { from, to: reachable(to, readLayout().total, box.clientHeight) };
      live.written = from;
      return true;
    },
    [readLayout, scrollRef],
  );
  const shifted = useCallback((by: number) => {
    const live = motion.current;
    if (!live?.walk) return;
    live.walk = { from: live.walk.from + by, to: live.walk.to + by };
    if (live.written !== null) live.written += by;
  }, []);
  const settle = useCallback(() => {
    if (!motion.current) return;
    finishWalk(motion.current, scrollRef.current);
    motion.current = null;
    draw();
  }, [scrollRef]);
  const ghost = useCallback((key: string) => motion.current?.ghosts.get(key), []);
  return { frame, ghost, takeWalk, shifted, settle };
}

/** Move the person's scroll walk on to `eased` — unless the person has
 * scrolled since the clock last wrote, in which case it is theirs. */
function walkTo<T>(motion: Motion<T>, list: HTMLElement | null, eased: number): void {
  if (!list || !motion.walk || motion.released) return;
  if (motion.written !== null && Math.abs(list.scrollTop - motion.written) > 1) {
    motion.released = true;
    return;
  }
  const top = walkAt(motion.walk.from, motion.walk.to, eased);
  list.scrollTop = top;
  motion.written = list.scrollTop;
  // As a browser would, so the virtualizer and the anchoring hear it.
  list.dispatchEvent(new Event("scroll"));
}

/** Land a fold's walk where it was going, at once. */
function finishWalk<T>(motion: Motion<T> | null, list: HTMLElement | null): void {
  if (motion) walkTo(motion, list, 1);
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
