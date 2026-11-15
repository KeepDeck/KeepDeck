import { addCost, costOf, emptyCostTally, tokensLessCacheReads, type CostTally, type UsageRow } from "../history/event";

/**
 * What Statistics counts — THE choice behind every amount the dialog folds,
 * ranks, compares and draws: the money at the model makers' list prices, or
 * the tokens less what was read back from cache (the work the calls did).
 * One choice for every tab that counts, so no tab can rank by one and show
 * the other.
 */
export type StatsMeasure = "spend" | "tokens";

export const STATS_MEASURES: readonly StatsMeasure[] = ["spend", "tokens"];

/** What every fold adds up, in both measures at once — the cost tally,
 * with its honesty about unpriced usage, and the tokens less cache reads —
 * so switching the measure re-reads a fold instead of redoing it. */
export interface UsageTally extends CostTally {
  tokensLessCacheReads: number;
}

export function emptyUsageTally(): UsageTally {
  return { ...emptyCostTally(), tokensLessCacheReads: 0 };
}

/** Add one row into a tally, in both measures. */
export function addUsage(into: UsageTally, row: UsageRow): void {
  addCost(into, row);
  into.tokensLessCacheReads += tokensLessCacheReads(row.tokens);
}

/** A row's amount in a measure — null for a row no price covers when the
 * measure is money: unknown, never free. Every row has its tokens. */
export function rowAmount(row: UsageRow, measure: StatsMeasure): number | null {
  return measure === "spend" ? costOf(row) : tokensLessCacheReads(row.tokens);
}

/** A tally's amount in a measure. */
export function amountOf(tally: UsageTally, measure: StatsMeasure): number {
  return measure === "spend" ? tally.costUsd : tally.tokensLessCacheReads;
}
