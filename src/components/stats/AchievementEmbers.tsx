import { useEffect, useRef } from "react";

/**
 * The legendary badge's embers: sparks that light somewhere on the card,
 * drift a few pixels, and go out.
 *
 * Not a flare and not a shimmer. Nothing travels — the whole journey is a
 * handful of pixels, which reads as the card giving off light rather than
 * as something flying past it. Every ember gets its own size, lifetime and
 * peak brightness, drawn additively so overlaps bloom.
 *
 * Position comes from a jittered GRID with one ember per cell, held for the
 * card's whole life. Independent random points clump, and a clump reads as
 * "all the sparks are in one corner"; cycling cells through a shorter pool
 * of embers leaves a gap that travels, which reads as a dead zone. One per
 * cell is the only arrangement with neither.
 */

/** Enough cells to cover a badge without crowding it. */
const CELLS_X = 6;
const CELLS_Y = 4;
const EMBERS = CELLS_X * CELLS_Y;
/** How far past the badge an ember may drift, and therefore how much room
 * the canvas needs beyond it. Must match the CSS inset. */
const HALO = 26;

interface Ember {
  cell: number;
  /** Where it lit, as a fraction of the card — a resize moves it along. */
  fx: number;
  fy: number;
  dx: number;
  dy: number;
  radius: number;
  peak: number;
  born: number;
  life: number;
}

/** The reader's standing answer about motion. One spelling, because the
 * component both asks it at mount and listens for it changing. */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function ember(cell: number, now: number, seeded: boolean): Ember {
  const life = 1900 + Math.random() * 2600;
  const angle = Math.random() * Math.PI * 2;
  const drift = 3 + Math.random() * 9;
  return {
    cell,
    fx: ((cell % CELLS_X) + 0.04 + Math.random() * 0.92) / CELLS_X,
    fy: (Math.floor(cell / CELLS_X) + 0.04 + Math.random() * 0.92) / CELLS_Y,
    dx: Math.cos(angle) * drift,
    dy: Math.sin(angle) * drift,
    radius: 1 + Math.pow(Math.random(), 1.7) * 3.4,
    peak: 0.55 + Math.random() * 0.45,
    born: now - (seeded ? Math.random() * life : 0),
    life,
  };
}

/** A full field, every ember mid-flight at its own phase. A field born all
 * at once reads as a single flash rather than as a card giving off light. */
export function seedField(now: number): Ember[] {
  return Array.from({ length: EMBERS }, (_, cell) => ember(cell, now, true));
}

/** Put a field back mid-flight, in place — see the resume path. */
export function reseed(embers: Ember[], now: number): void {
  for (let index = 0; index < embers.length; index += 1) {
    embers[index] = ember(embers[index].cell, now, true);
  }
}

type Rgb = readonly [number, number, number];

/** Legendary's gold, for the DOM the stylesheet never reaches. The level's
 * colour has one home — `--rarity-legendary` in stats-achievements.css — but
 * a canvas gradient cannot say `var()`, so the component reads the resolved
 * value once at mount instead of restating the hex. The literal survives
 * only as the answer for a DOM that computes no styles at all. */
export const FALLBACK_GOLD: Rgb = [217, 164, 65];

function rarityGold(element: Element): Rgb {
  const raw = getComputedStyle(element)
    .getPropertyValue("--rarity-legendary")
    .trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const digits = hex[1];
    const wide =
      digits.length === 3
        ? digits.replace(/./g, (digit) => digit + digit)
        : digits;
    return [
      parseInt(wide.slice(0, 2), 16),
      parseInt(wide.slice(2, 4), 16),
      parseInt(wide.slice(4, 6), 16),
    ];
  }
  const channels = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (channels) {
    const parts = channels[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return FALLBACK_GOLD;
}

/** Toward white, for the spark's hotter inner rings. */
function tint([r, g, b]: Rgb, amount: number): Rgb {
  const lift = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return [lift(r), lift(g), lift(b)];
}

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

/** One glow, drawn once and stamped everywhere — building a gradient per
 * ember per frame would be the expensive part of this. */
function sprite(gold: Rgb): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.22, rgba(tint(gold, 0.78), 0.95));
  glow.addColorStop(0.5, rgba(gold, 0.45));
  glow.addColorStop(1, rgba(gold, 0));
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
    const glow = sprite(rarityGold(canvas));
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
      const box = canvas.getBoundingClientRect();
      // A box smaller than the halo it carries has no room for a field at
      // all: `width - HALO * 2` would go NEGATIVE and every ember would map
      // outside the bitmap. A card with no layout box — an ancestor is
      // `display: none` — is exactly that case, so the field simply waits
      // for the resize that gives it one.
      const next = Math.round(box.width);
      const nextHeight = Math.round(box.height);
      if (next === width && nextHeight === height) return;
      if (next < HALO * 2 || nextHeight < HALO * 2) return;
      width = next;
      height = nextHeight;
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
        const age = now - spark.born;
        if (age > spark.life) {
          // Reborn in its OWN cell, so the coverage never drifts.
          embers[index] = ember(spark.cell, now, false);
          continue;
        }
        const life = age / spark.life;
        const x = HALO + spark.fx * (width - HALO * 2) + spark.dx * life;
        const y = HALO + spark.fy * (height - HALO * 2) + spark.dy * life;
        // One smooth breath: dark, up to its own peak, dark again. A
        // flicker on top of this is what turns embers into noise.
        const fade = Math.sin(Math.PI * life);
        const size = spark.radius * (0.7 + fade * 0.45);
        const halo = size * 2;
        context.globalAlpha = Math.max(0, fade * fade * spark.peak);
        context.drawImage(glow, x - halo, y - halo, halo * 2, halo * 2);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    };
    /** Two independent reasons to hold still, one switch. Both are live: the
     * reader can scroll the badge away and can change their mind about
     * motion, and the CSS half of the second answers the moment they do. */
    const motion = window.matchMedia?.(REDUCED_MOTION) ?? null;
    let offscreen = false;
    let running = false;

    const sync = () => {
      const wanted = !offscreen && motion?.matches !== true;
      if (wanted === running) return;
      running = wanted;
      if (!wanted) {
        cancelAnimationFrame(frame);
        context.clearRect(0, 0, width, height);
        return;
      }
      // RESEEDED, not merely restarted. Every ember whose life ran out while
      // the loop was parked would otherwise be reborn on the same frame with
      // the same phase: the badge goes dark, blooms at nearly twice its
      // steady brightness, then troughs. And because the observer reports
      // every newly visible card in one batch, the whole grid does it in
      // step — the ripple this design gave up a shimmer to avoid.
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
