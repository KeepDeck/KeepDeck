import { formatTokens, formatUsd } from "../../domain/usage";
import type { StatsMeasure, UsageTally } from "../../domain/usage/stats/measure";
import { costCoverage, displayCost } from "./statsCost";

/**
 * How the Statistics screen speaks of an amount in the measure the reader
 * picked — the switch's words, a tally's figure, a bare value, and the note
 * on what the figures count. Money goes through statsCost, its one voice;
 * every Record here is exhaustive, so a new measure fails to compile until
 * it names itself everywhere.
 */

export const MEASURE_LABELS: Record<StatsMeasure, string> = {
  spend: "Spend",
  tokens: "Tokens",
};

/** A tally in the measure: money as displayCost says it ("—" for nothing
 * priced, "+" beside unpriced usage), or its tokens less cache reads. */
export function displayAmount(tally: UsageTally, measure: StatsMeasure): string {
  return measure === "spend" ? displayCost(tally) : formatTokens(tally.tokensLessCacheReads);
}

/** A bare amount — a chart's bar or axis — in the measure. */
export function formatAmount(value: number, measure: StatsMeasure): string {
  return measure === "spend" ? formatUsd(value, { approx: true }) : formatTokens(value);
}

const TOKENS_NOTE =
  "Tokens count fresh input, output with its reasoning and cache writes; what was read back from cache is left out.";

/** What the figures count, said once under a tab: the money's source and
 * coverage, or what a token figure leaves out. */
export function measureNote(totals: UsageTally & { totalTokens: number }, measure: StatsMeasure): string {
  return measure === "spend" ? costCoverage(totals) : TOKENS_NOTE;
}
