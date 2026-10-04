import { changedAfter } from "./rowAnchor";

/** What a change of a list's rows marks: the keys that joined there and
 * ease in (null: nothing eases), and the item the change happened after,
 * held in place (`changedAfter`; null: nothing is held). */
export interface MotionMarks {
  arriving: ReadonlySet<string> | null;
  held: string | null;
}

/**
 * The marks one change of the rows leaves — the list's motion rule, pure.
 * `eased` is whether the person made it (the consumer's token changed
 * with the rows); `standing` the marks of the change before.
 *
 * - The person's change: the rows that joined arrive, and the item it
 *   happened after is held.
 * - The same rows again, not the person's (a clock tick re-dated them):
 *   no change of place, so the entrance standing runs out — and nothing
 *   is held: a hold is for the change that made it, once.
 * - Any other change: nothing moves, nothing is held.
 */
export function motionOf(
  before: readonly string[],
  after: readonly string[],
  eased: boolean,
  standing: MotionMarks,
): MotionMarks {
  if (!eased && sameKeys(before, after)) return { arriving: standing.arriving, held: null };
  if (!eased) return { arriving: null, held: null };
  const was = new Set(before);
  return { arriving: new Set(after.filter((key) => !was.has(key))), held: changedAfter(before, after) };
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}
