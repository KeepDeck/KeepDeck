import {
  costCoverage,
  displayCost,
  formatTokens,
  formatUtcDay,
  PERIOD_LABELS,
  tokenBreakdown,
} from "../../domain/usage";
import type { UsageStats, UsageStatsPeriod } from "../../domain/usage/history/query";
import type { UsageRecap } from "../../domain/usage/recap";

/**
 * The Overview tab's words and numbers, settled: the headline cards, the
 * Highlights sentence and the cost note. The component lays them out
 * around the chart and the weeks.
 */

/** One headline card: what it counts, the number, and what the number is
 * made of when it has parts worth naming. */
export interface SummaryCardView {
  label: string;
  value: string;
  detail: string | null;
}

export interface OverviewView {
  cards: SummaryCardView[];
  /** The Highlights sentence, or none when the period offers nothing. */
  recap: string | null;
  coverage: string;
  /** What shows where the chart could not be loaded. */
  chartError: string;
}

/** THE Highlights sentence — which highlights appear, their order, the
 * separator and the sign convention, in one place so a digest notification
 * or a copy-summary command reuses the exact wording instead of re-deriving
 * it. Empty when the period offers no highlight worth reading. */
export function recapCaption(recap: UsageRecap, period: UsageStatsPeriod): string {
  const parts: string[] = [];
  if (recap.tokensDeltaPct !== null) {
    const sign = recap.tokensDeltaPct >= 0 ? "+" : "";
    parts.push(`${sign}${recap.tokensDeltaPct}% vs prior ${PERIOD_LABELS[period]}`);
  }
  if (recap.topModel) {
    parts.push(`top model ${recap.topModel.model} (${formatTokens(recap.topModel.totalTokens)})`);
  }
  if (recap.busiestDay) {
    parts.push(
      `busiest day ${formatUtcDay(recap.busiestDay.dayStart)} (${formatTokens(recap.busiestDay.totalTokens)})`,
    );
  }
  return parts.join(" · ");
}

export function overviewView(stats: UsageStats, recap: UsageRecap, period: UsageStatsPeriod): OverviewView {
  // The headline number with what it is MADE of: a bare total hides the
  // split that explains the bill — cache reads usually dominate it and are
  // priced differently.
  const breakdown = tokenBreakdown(stats.totals.tokens);
  const highlights = recapCaption(recap, period);
  return {
    cards: [
      { label: "Tokens", value: formatTokens(stats.totals.totalTokens), detail: breakdown === "" ? null : breakdown },
      { label: "Cost", value: displayCost(stats.totals), detail: null },
      { label: "Sessions", value: String(stats.sessionCount), detail: null },
    ],
    recap: highlights === "" ? null : highlights,
    coverage: costCoverage(stats.totals),
    chartError: "The chart could not be loaded.",
  };
}
