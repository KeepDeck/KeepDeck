import { changedAfter } from "./rowAnchor";

/** What one change of a list's rows is to the list: whether the person
 * made it (it is painted as a fold, `useFoldMotion`), and the item it
 * happened after, held in place (`changedAfter`; null: nothing held). */
export interface ChangeMarks {
  eased: boolean;
  held: string | null;
}

/**
 * What one change of the rows is — the rule, pure. `eased` is whether the
 * person made it (the consumer's token changed with the rows).
 *
 * - The person's change: it moves, and the item it happened after is held.
 * - Any other change — an agent's, a fresh array of the same rows: it
 *   lands still, and holds nothing (a hold is for the change that made
 *   it, once).
 */
export function marksOf(before: readonly string[], after: readonly string[], eased: boolean): ChangeMarks {
  return eased ? { eased: true, held: changedAfter(before, after) } : { eased: false, held: null };
}
