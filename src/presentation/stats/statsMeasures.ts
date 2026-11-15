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

/** Why a chart in the measure has nothing to draw, or null when it has:
 * no usage at all — `noUsage`, the period's own words for it, null when
 * there was some — or, in money, usage no price covers. Tokens are known
 * for every row. */
export function nothingToDraw(noUsage: string | null, totals: UsageTally, measure: StatsMeasure): string | null {
  if (noUsage !== null) return noUsage;
  return measure === "spend" && totals.pricedEvents === 0 ? "None of this usage has a known price." : null;
}

/** What this machine used inside a provider window, as one line, in the
 * measure: its tokens and sessions, then — in money, once one of them was
 * priced — their cost; in tokens, the tokens less cache reads. The branch
 * is on the tally, never on the formatter's dash — a reworded "no data"
 * must not change the line. */
export function windowLedgerCaption(
  ledger: UsageTally & { sessionCount: number; totalTokens: number },
  measure: StatsMeasure,
): string {
  if (ledger.sessionCount === 0) return "no usage this window";
  const sessions = `${ledger.sessionCount} session${ledger.sessionCount === 1 ? "" : "s"}`;
  if (measure === "tokens") return `${formatTokens(ledger.tokensLessCacheReads)} tokens · ${sessions} this window`;
  const spend = ledger.pricedEvents === 0 ? sessions : `${sessions} · ${displayCost(ledger)}`;
  return `${formatTokens(ledger.totalTokens)} · ${spend} this window`;
}
