import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  easeFold,
  foldFrame,
  mergeFolds,
  reachable,
  segmentsOf,
  walkAt,
  type FoldFrame,
  type FoldSegment,
  type Layout,
} from "./foldMotion";

/** How long a fold takes, start to end. */
export const FOLD_MOTION_MS = 160;

/** A fold worked out from one change of the rows, before it is put in
 * flight: where the rows changed, and the rows that left (to draw as
 * ghosts) with their items and old indexes. */
interface Proposal<T> {
  segments: readonly FoldSegment[];
  ghosts: ReadonlyMap<string, { item: T; index: number }>;
}

/** One segment in flight, on its own clock: folds made one after another
 * each run their own time. */
interface Part {
  segment: FoldSegment;
  /** How much was left to play when its clock started (`mergeFolds`). */
  from: number;
  startedAt: number | null;
  residual: number;
}

/** The folds in flight, the rows they draw as ghosts, and the person's
 * scroll walk. */
interface Motion<T> {
  parts: Part[];
  ghosts: Map<string, { item: T; index: number }>;
  /** The walk the latest fold's hold asked for: from where the scroll
   * stood to where the hold put the folded heading, on its own clock. */
  walk: { from: number; to: number; startedAt: number | null } | null;
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
  /** A ghost's item and its old index, by key. */
  ghost(key: string): { item: T; index: number } | undefined;
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
  // Folds already put in flight — each is started once, whatever renders after.
  const started = useRef(new WeakSet<Proposal<T>>());
  /** The motion the clock is running. */
  const [running, setRunning] = useState<Motion<T> | null>(null);

  // The layout of this render, read once, when a fold is made or painted.
  let now: Layout | null = null;
  const layoutNow = () => (now ??= readLayout());
  // The fold this change of the rows makes, if it is the person's: worked
  // out in render, purely — what it writes happens when it is put in
  // flight, after the commit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const made = useMemo(() => (eased && drawn.current !== null && !reducedMotion() ? proposalFrom(drawn.current, layoutNow()) : null), [items]);
  const pending = useRef<Proposal<T> | null>(null);
  pending.current = made !== null && !started.current.has(made) ? made : null;
  /** Put this render's fold in flight — once. A fold still playing goes on
   * beside it; the same group folded back turns round from where it has
   * got to (`mergeFolds`). Asked by the hold (whose layout effect runs
   * first) and by this hook's own. True when it started one just now. */
  const start = useCallback(() => {
    const next = pending.current;
    if (next === null || started.current.has(next)) return false;
    started.current.add(next);
    const playing = motion.current;
    const merged = mergeFolds(playing?.parts ?? [], next.segments);
    const parts: Part[] = [
      ...merged.kept.map((index) => playing!.parts[index]),
      ...merged.added.map((part) => ({ ...part, startedAt: null, residual: part.from })),
    ];
    const ghosts = new Map(playing?.ghosts ?? []);
    for (const [key, ghost] of next.ghosts) ghosts.set(key, ghost);
    motion.current = { parts, ghosts, walk: playing?.walk ?? null, written: playing?.written ?? null, released: playing?.released ?? false };
    // The clock runs it — a render before the paint, in the layout phase
    // this is asked in.
    setRunning(motion.current);
    return true;
  }, []);
  useLayoutEffect(() => {
    start();
  });

  // What this render drew is the "before" of the next fold — kept only
  // by a list that folds, and only in its own copy.
  useLayoutEffect(() => {
    if (folds) drawn.current = { items, layout: layoutNow() };
  });

  const settle = useCallback(() => {
    if (!motion.current) return;
    finishWalk(motion.current, scrollRef.current);
    motion.current = null;
    setRunning(null);
    draw();
  }, [scrollRef]);

  // The clock: one frame at a time while a motion lasts.
  useEffect(() => {
    if (!running) return;
    const list = scrollRef.current;
    const release = () => {
      running.released = true;
    };
    const events = ["wheel", "touchstart", "pointerdown"] as const;
    for (const name of events) list?.addEventListener(name, release, { passive: true });
    // Reduced motion asked for mid-fold: the fold lands, now.
    const preference = typeof window !== "undefined" ? window.matchMedia?.(REDUCE) : undefined;
    const reduce = (event: MediaQueryListEvent) => {
      if (event.matches) settle();
    };
    preference?.addEventListener?.("change", reduce);
    let frameId = 0;
    const tick = (time: number) => {
      if (motion.current !== running) return;
      let done = true;
      for (const part of running.parts) {
        part.startedAt ??= time;
        part.residual = part.from * (1 - easeFold((time - part.startedAt) / FOLD_MOTION_MS));
        if (part.residual > 0) done = false;
      }
      if (running.walk) {
        running.walk.startedAt ??= time;
        const walked = easeFold((time - running.walk.startedAt) / FOLD_MOTION_MS);
        walkTo(running, list, walked);
        if (walked < 1 && !running.released) done = false;
      }
      if (done) motion.current = null;
      // Drawn in THIS frame: a render left to the scheduler would land after
      // the paint, the rows a step behind the scroll the clock just wrote.
      // Done, the clock lets the motion go — and its ghosts' items with it.
      flushSync(() => {
        draw();
        if (done) setRunning(null);
      });
      if (motion.current === running) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
      for (const name of events) list?.removeEventListener(name, release);
      preference?.removeEventListener?.("change", reduce);
    };
  }, [running, scrollRef, settle]);

  // What is drawn: the motion in flight, with this render's fold merged in
  // as it will be once started (so the first frame is the fold's own).
  const current = motion.current;
  const parts = pending.current ? previewParts(current?.parts ?? [], pending.current.segments) : (current?.parts ?? []);
  // During a fold, which rows to mount is decided by where they are
  // DRAWN — so the scroll box is read here, the one time a render asks.
  const list = scrollRef.current;
  const frame =
    parts.length > 0
      ? foldFrame(
          parts.map((part) => part.segment),
          layoutNow(),
          parts.map((part) => part.residual),
          { top: list?.scrollTop ?? 0, height: list?.clientHeight ?? 0, overscan },
        )
      : null;

  const takeWalk = useCallback(
    (from: number, to: number) => {
      // Only a fold of THIS change walks its hold: a change of the person's
      // that makes no motion (a reorder, reduced motion) holds at once,
      // even while an earlier fold is still in flight.
      if (!start()) return false;
      const live = motion.current;
      const box = scrollRef.current;
      if (!live || !box) return false;
      live.walk = { from, to: reachable(to, readLayout().total, box.clientHeight), startedAt: null };
      live.written = from;
      live.released = false;
      return true;
    },
    [readLayout, scrollRef, start],
  );
  const shifted = useCallback((by: number) => {
    const live = motion.current;
    if (!live?.walk) return;
    live.walk = { ...live.walk, from: live.walk.from + by, to: live.walk.to + by };
    if (live.written !== null) live.written += by;
  }, []);
  const ghost = useCallback(
    (key: string) => motion.current?.ghosts.get(key) ?? pending.current?.ghosts.get(key),
    [],
  );
  return { frame, ghost, takeWalk, shifted, settle };
}

/** The parts a fold not yet started would run with — for drawing the
 * render it is made in, before its commit starts it. */
function previewParts(playing: readonly Part[], next: readonly FoldSegment[]): Part[] {
  const merged = mergeFolds(playing, next);
  return [
    ...merged.kept.map((index) => playing[index]),
    ...merged.added.map((part) => ({ ...part, startedAt: null, residual: part.from })),
  ];
}

/** The fold a change of the rows makes, from what was drawn before to the
 * layout now — or null when it is no fold (nothing changed place, or the
 * rows that stayed were reordered). */
function proposalFrom<T>(before: { items: readonly T[]; layout: Layout }, layout: Layout): Proposal<T> | null {
  const segments = segmentsOf(before.layout, layout);
  if (segments === null || segments.length === 0) return null;
  const left = new Set(segments.flatMap((segment) => segment.ghosts.map((ghost) => ghost.key)));
  const ghosts = new Map<string, { item: T; index: number }>();
  for (const [index, row] of before.layout.rows.entries()) {
    if (left.has(row.key)) ghosts.set(row.key, { item: before.items[index], index });
  }
  return { segments, ghosts };
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

const REDUCE = "(prefers-reduced-motion: reduce)";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(REDUCE).matches === true;
}
