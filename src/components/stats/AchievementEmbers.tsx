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

/** One glow, drawn once and stamped everywhere — building a gradient per
 * ember per frame would be the expensive part of this. */
function sprite(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.22, "rgba(255,236,180,0.95)");
  glow.addColorStop(0.5, "rgba(217,164,65,0.45)");
  glow.addColorStop(1, "rgba(217,164,65,0)");
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
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const glow = sprite();
    const embers = Array.from({ length: EMBERS }, (_, cell) =>
      ember(cell, performance.now(), true),
    );
    let width = 0;
    let height = 0;

    /** Geometry is read on a RESIZE, never per frame: a badge's box moves
     * when the layout does, and reading it every frame would force a
     * synchronous layout sixty times a second for a number that stands
     * still. */
    const measure = () => {
      const box = card.getBoundingClientRect();
      const next = Math.max(1, Math.round(box.width + HALO * 2));
      const nextHeight = Math.max(1, Math.round(box.height + HALO * 2));
      if (next === width && nextHeight === height) return;
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
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, []);

  // Sized OUTRIGHT, never through `inset`: a canvas is a replaced element,
  // so with `width: auto` it takes its own bitmap as its box and ignores the
  // right and bottom offsets — the box then stops short of the card's lower
  // edge and every ember drawn down there falls outside it.
  return (
    <canvas ref={canvasRef} className="stats__achievement-embers" aria-hidden />
  );
}
