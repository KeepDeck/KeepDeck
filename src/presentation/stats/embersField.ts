/**
 * The legendary badge's embers as a field, without the canvas: where each
 * ember lights, how it drifts, breathes and goes out, how the gold reads,
 * and when the field may run. The component owns the canvas, the observers
 * and the frame loop, and asks this for every number it draws.
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
export const HALO = 26;

export interface Ember {
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

/** A new ember in `cell`, born `now` — or, `seeded`, already somewhere in
 * its life. */
export function ember(cell: number, now: number, seeded: boolean): Ember {
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

/** Put a field back mid-flight, in place. Every ember whose life ran out
 * while the loop was parked would otherwise be reborn on the same frame with
 * the same phase: the badge goes dark, blooms at nearly twice its steady
 * brightness, then troughs — and because newly visible cards are reported in
 * one batch, the whole grid does it in step. */
export function reseed(embers: Ember[], now: number): void {
  for (let index = 0; index < embers.length; index += 1) {
    embers[index] = ember(embers[index].cell, now, true);
  }
}

/** Whether an ember's life has run out at `now`: it is reborn in its OWN
 * cell, so the coverage never drifts. */
export function emberSpent(spark: Ember, now: number): boolean {
  return now - spark.born > spark.life;
}

/** Where and how bright an ember is at `now`, on a field of `width` ×
 * `height`: its centre, the half-size of its glow, and its alpha. */
export function emberDraw(
  spark: Ember,
  now: number,
  width: number,
  height: number,
): { x: number; y: number; halo: number; alpha: number } {
  const life = (now - spark.born) / spark.life;
  // One smooth breath: dark, up to its own peak, dark again. A flicker on
  // top of this is what turns embers into noise.
  const fade = Math.sin(Math.PI * life);
  const size = spark.radius * (0.7 + fade * 0.45);
  return {
    x: HALO + spark.fx * (width - HALO * 2) + spark.dx * life,
    y: HALO + spark.fy * (height - HALO * 2) + spark.dy * life,
    halo: size * 2,
    alpha: Math.max(0, fade * fade * spark.peak),
  };
}

/** The field's size for a measured box, or null when nothing changes: the
 * same size, or a box smaller than the halo it carries — `width - HALO * 2`
 * would go negative and every ember would map outside the bitmap. A card
 * with no layout box (an ancestor is `display: none`) is exactly that case,
 * so the field waits for the resize that gives it one. */
export function fieldSize(
  box: { width: number; height: number },
  current: { width: number; height: number },
): { width: number; height: number } | null {
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  if (width === current.width && height === current.height) return null;
  if (width < HALO * 2 || height < HALO * 2) return null;
  return { width, height };
}

/** Whether the field runs: two independent reasons to hold still — nobody
 * is looking at it, or the reader asked for less motion. */
export function fieldRuns(offscreen: boolean, reducedMotion: boolean): boolean {
  return !offscreen && !reducedMotion;
}

export type Rgb = readonly [number, number, number];

/** Legendary's gold for a DOM that computes no styles at all. The level's
 * colour has one home — `--rarity-legendary` in stats-achievements.css —
 * and a canvas gradient cannot say `var()`, so the component reads the
 * resolved value and hands it here. */
export const FALLBACK_GOLD: Rgb = [233, 174, 72];

/** The gold a resolved `--rarity-legendary` value says: a hex colour, an
 * rgb()/rgba() one, or the fallback for anything else. */
export function parseGold(raw: string): Rgb {
  const value = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1];
    const wide = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
    return [parseInt(wide.slice(0, 2), 16), parseInt(wide.slice(2, 4), 16), parseInt(wide.slice(4, 6), 16)];
  }
  const channels = /^rgba?\(([^)]+)\)$/i.exec(value);
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

/** The glow's radial stops, white-hot at the centre and gold to nothing at
 * the edge — drawn once and stamped everywhere. */
export function glowStops(gold: Rgb): [number, string][] {
  return [
    [0, "rgba(255,255,255,1)"],
    [0.22, rgba(tint(gold, 0.78), 0.95)],
    [0.5, rgba(gold, 0.45)],
    [1, rgba(gold, 0)],
  ];
}
