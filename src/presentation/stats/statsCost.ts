import { formatTokens, formatUsd } from "../../domain/usage";
import type { CostTally } from "../../domain/usage/history/event";

/**
 * How the Statistics screen speaks of money: a cost figure, the note on
 * where the figures come from, and a provider window's spend line. Every
 * money fold hands its CostTally here; none phrases it itself.
 */

/** A cost aggregate: "—" until at least one event carried a price —
 * nothing priced must never read as "free" — and a "+" on a sum that has
 * unpriced usage in it, which the coverage note explains. */
export function displayCost(cost: Pick<CostTally, "costUsd" | "pricedEvents" | "unpricedTokens">): string {
  if (cost.pricedEvents === 0) return "—";
  return `${formatUsd(cost.costUsd, { approx: true })}${cost.unpricedTokens > 0 ? "+" : ""}`;
}

const COST_SOURCE =
  "Costs are estimated from each model maker's list price at the time of the call (models.dev), not subscription charges.";

/** The cost-provenance note under the Overview cards — the one text that
 * says where the money figures come from and how much of the usage they
 * cover. */
export function costCoverage(totals: CostTally & { totalTokens: number }): string {
  if (totals.pricedEvents === 0) {
    return totals.totalTokens === 0
      ? COST_SOURCE
      : "No model in this period has a known price. Token totals remain available.";
  }
  const notes = [COST_SOURCE];
  if (totals.approximateEvents > 0) {
    notes.push("Some are approximate, priced by the nearest known rate.");
  }
  if (totals.unpricedTokens > 0) {
    const share = (totals.unpricedTokens / totals.totalTokens) * 100;
    notes.push(
      `${share < 1 ? "<1" : Math.round(share)}% of tokens ran on models without a known price and are not counted; “+” marks a sum they are missing from.`,
    );
  }
  return notes.join(" ");
}

/** What this machine spent inside a provider window, as one line: its
 * tokens, its sessions, and their cost once one of them was priced. The
 * branch is on the tally, never on the formatter's dash — a reworded "no
 * data" must not change the line. */
export function windowLedgerCaption(
  ledger: Pick<CostTally, "costUsd" | "pricedEvents" | "unpricedTokens"> & {
    sessionCount: number;
    totalTokens: number;
  },
): string {
  if (ledger.sessionCount === 0) return "no usage this window";
  const sessions = `${ledger.sessionCount} session${ledger.sessionCount === 1 ? "" : "s"}`;
  const spend = ledger.pricedEvents === 0 ? sessions : `${sessions} · ${displayCost(ledger)}`;
  return `${formatTokens(ledger.totalTokens)} · ${spend} this window`;
}
