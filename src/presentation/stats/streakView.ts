import { streakHeat, type StreakHeat } from "../../domain/usage/streak";

/**
 * The live streak chip, settled — the longer the streak, the louder the
 * look. Each heat tier carries its own mark: nothing at 1–2 days, a
 * breathing coal from 3, a small swaying flame from 7, a bigger flame from
 * 30, and a white-hot core with rising sparks from 100. The component draws
 * the SVG and decides nothing.
 */

/** One rising ember, with its own drift, tempo and phase. */
export interface StreakSpark {
  dx: string;
  dur: string;
  delay: string;
  left: string;
}

const SPARKS: readonly StreakSpark[] = [
  { dx: "5px", dur: "2s", delay: "0s", left: "45%" },
  { dx: "-4px", dur: "2.5s", delay: "0.6s", left: "55%" },
  { dx: "7px", dur: "2.2s", delay: "1.1s", left: "40%" },
  { dx: "-6px", dur: "2.7s", delay: "1.6s", left: "60%" },
  { dx: "3px", dur: "1.9s", delay: "2.1s", left: "50%" },
];

/** The flame's size by heat, in pixels. */
const FLAME_SIZE: Record<"flame" | "blaze" | "inferno", number> = {
  flame: 13,
  blaze: 16,
  inferno: 18,
};

export type StreakMarkView =
  | { kind: "none" }
  | { kind: "coal" }
  | {
      kind: "fire";
      size: number;
      /** The white-hot core: a hot path, a louder mark, and sparks. */
      inferno: boolean;
      sparks: readonly StreakSpark[];
    };

export interface StreakView {
  heat: StreakHeat;
  /** What the chip says to a screen reader. */
  label: string;
  count: string;
  unit: string;
  mark: StreakMarkView;
}

function markOf(heat: StreakHeat): StreakMarkView {
  if (heat === "none") return { kind: "none" };
  if (heat === "ember") return { kind: "coal" };
  const inferno = heat === "inferno";
  return { kind: "fire", size: FLAME_SIZE[heat], inferno, sparks: inferno ? SPARKS : [] };
}

/** The chip for a streak of `days`, or none at zero: no streak is no chip. */
export function streakView(days: number): StreakView | null {
  if (days === 0) return null;
  const heat = streakHeat(days);
  return {
    heat,
    label: `${days}-day streak`,
    count: String(days),
    unit: days === 1 ? "day" : "days",
    mark: markOf(heat),
  };
}
