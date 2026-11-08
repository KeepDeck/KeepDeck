import { useEffect, useRef } from "react";
import {
  emberDraw,
  ember,
  emberSpent,
  fieldRuns,
  fieldSize,
  glowStops,
  parseGold,
  reseed,
  seedField,
  type Rgb,
} from "../../presentation/stats/embersField";

/**
 * The legendary badge's embers: sparks that light somewhere on the card,
 * drift a few pixels, and go out. Every number drawn comes from
 * presentation/stats/embersField.ts; this owns the canvas, the observers
 * and the frame loop.
 */

/** The reader's standing answer about motion. One spelling, because the
 * component both asks it at mount and listens for it changing. */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** One glow, drawn once and stamped everywhere — building a gradient per
 * ember per frame would be the expensive part of this. */
function sprite(gold: Rgb): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [offset, color] of glowStops(gold)) glow.addColorStop(offset, color);
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 64);
  return canvas;
}

/** Mounted only on an earned legendary card, so the animation exists in the
 * handful of places that earned it and nowhere else. */
export function AchievementEmbers() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const card = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    // No drawing surface (a stubbed canvas under a test DOM) means there is
    // nothing to animate; the badge renders fully without it either way.
    if (!canvas || !card || !context || typeof context.drawImage !== "function") {
      return;
    }
    // The level's gold has one home, the stylesheet's `--rarity-legendary`;
    // a canvas gradient cannot say `var()`, so it is read resolved, once.
    const glow = sprite(parseGold(getComputedStyle(canvas).getPropertyValue("--rarity-legendary")));
    const embers = seedField(performance.now());
    let width = 0;
    let height = 0;

    /** Geometry is read on a RESIZE, never per frame: a badge's box moves
     * when the layout does, and reading it every frame would force a
     * synchronous layout sixty times a second for a number that stands
     * still.
     *
     * The measured box is the CANVAS's, not the card's. They differ: the
     * stylesheet sizes this element as `100% + 2 × HALO`, and a percentage
     * resolves against the card's PADDING box, while the card's own rect is
     * its border box. Measuring the card made the field one pixel wider than
     * the element drawing it, so the inner area the embers were told to stay
     * inside was not quite the card. Reading the box that actually exists
     * makes `HALO` exact by construction.
     *
     * There is deliberately no size cap. One used to sit here against the
     * runaway that a content rule caused once, by putting the canvas back in
     * the flow so the card grew from a height its own bitmap set. The cap
     * could never have stopped that: the box comes from CSS, not from the
     * bitmap, so writing `canvas.width` cannot move it. What actually closes
     * the loop is that the canvas is out of the flow — the shared layer class
     * — and, if it ever were not, the size settles in one step anyway. A
     * guard that cannot fire and would not help is worse than none: it reads
     * as protection. */
    const measure = () => {
      const next = fieldSize(canvas.getBoundingClientRect(), { width, height });
      if (!next) return;
      width = next.width;
      height = next.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    measure();

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(card);

    let frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      // No usable box yet (the card is hidden): nothing to draw into, and
      // the ember maths would map outside the bitmap if it tried.
      if (width === 0) return;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      for (let index = 0; index < embers.length; index += 1) {
        const spark = embers[index];
        if (emberSpent(spark, now)) {
          embers[index] = ember(spark.cell, now, false);
          continue;
        }
        const at = emberDraw(spark, now, width, height);
        context.globalAlpha = at.alpha;
        context.drawImage(glow, at.x - at.halo, at.y - at.halo, at.halo * 2, at.halo * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    };
    /** Both reasons to hold still are live: the reader can scroll the badge
     * away and can change their mind about motion, and the CSS half of the
     * second answers the moment they do. */
    const motion = window.matchMedia?.(REDUCED_MOTION) ?? null;
    let offscreen = false;
    let running = false;

    const sync = () => {
      const wanted = fieldRuns(offscreen, motion?.matches === true);
      if (wanted === running) return;
      running = wanted;
      if (!wanted) {
        cancelAnimationFrame(frame);
        context.clearRect(0, 0, width, height);
        return;
      }
      // RESEEDED, not merely restarted — see reseed.
      reseed(embers, performance.now());
      frame = requestAnimationFrame(draw);
    };
    sync();

    /** A full gallery is a wall of legendary badges, each with its own draw
     * loop, and the dialog shows perhaps two rows at a time. A field nobody
     * is looking at costs nothing.
     *
     * The viewport is the right root even though the scroller is the dialog
     * body: an intersection rect is clipped by every clipping ancestor on
     * the way up, and the body is one of them. */
    const gate =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            offscreen = !(entries[entries.length - 1]?.isIntersecting ?? true);
            sync();
          });
    gate?.observe(canvas);
    motion?.addEventListener?.("change", sync);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      gate?.disconnect();
      motion?.removeEventListener?.("change", sync);
    };
  }, []);

  // Sized OUTRIGHT, never through `inset`: a canvas is a replaced element,
  // so with `width: auto` it takes its own bitmap as its box and ignores the
  // right and bottom offsets — the box then stops short of the card's lower
  // edge and every ember drawn down there falls outside it.
  return (
    <canvas
      ref={canvasRef}
      className="stats__achievement-embers stats__achievement-layer"
      aria-hidden
    />
  );
}
