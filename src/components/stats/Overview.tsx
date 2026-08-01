import { lazy, Suspense, useMemo } from "react";
import {
  costCoverage,
  displayProviderCost,
  formatTokens,
  formatUtcDay,
  PERIOD_LABELS,
} from "../../domain/usage";
import { CHART_HEIGHT } from "../../domain/usage/chartPalette";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import type {
  UsageStats,
  UsageStatsPeriod,
} from "../../domain/usage/history/query";
import { usageRecap, type UsageRecap } from "../../domain/usage/recap";
import { ErrorBoundary } from "../../ui/ErrorBoundary";

/** The chart rides its own chunk: recharts is the bundle's single largest
 * dependency (+45% gzip over the whole app), parsed at cold launch if
 * imported statically — for a chart behind a dialog tab. */
const UsageChart = lazy(() =>
  import("./UsageChart").then((module) => ({ default: module.UsageChart })),
);

/** The Overview tab body: the period's headline numbers, the tokens-over-
 * time chart, the highlights recap and the cost-coverage disclaimer. Mounts
 * only while its tab is selected, so the recap — the tab's own derived
 * view — is memoized here rather than computed for tabs that never show
 * it. Empty/dead-ledger gating stays with the tab switchboard, which owns
 * that rule for every ledger-backed tab. */
export function Overview({
  events,
  stats,
  period,
  now,
}: {
  events: readonly UsageEventV2[];
  stats: UsageStats;
  period: UsageStatsPeriod;
  now: number;
}) {
  const recap = useMemo(
    () => usageRecap(events, period, now, stats),
    [events, period, now, stats],
  );
  return (
    <>
      <div className="stats__summary">
        <Summary label="Tokens" value={formatTokens(stats.totals.totalTokens)} />
        <Summary
          label="Cost"
          value={displayProviderCost(
            stats.totals.providerCostUsd,
            stats.totals.costEvents,
          )}
        />
        <Summary label="Sessions" value={String(stats.sessionCount)} />
      </div>
      {/* A failed chunk load loses the chart, never the app — without a
          boundary a rejected lazy import unwinds to the root and blanks
          the whole window. */}
      <ErrorBoundary
        label="Statistics chart"
        fallback={
          <p className="stats__warning">The chart could not be loaded.</p>
        }
      >
        <Suspense fallback={<ChartPlaceholder />}>
          <UsageChart events={events} period={period} now={now} />
        </Suspense>
      </ErrorBoundary>
      <Highlights recap={recap} period={period} />
      <p className="stats__coverage">
        {costCoverage(stats.costSessionCount, stats.sessionCount)}
      </p>
    </>
  );
}

/** The period's numbers with their context — movement against the prior
 * equal-length period, the hungriest model, the heaviest day. Renders
 * nothing when the period offers no highlight worth reading. */
function Highlights({
  recap,
  period,
}: {
  recap: UsageRecap;
  period: UsageStatsPeriod;
}) {
  const parts: string[] = [];
  if (recap.tokensDeltaPct !== null) {
    const sign = recap.tokensDeltaPct >= 0 ? "+" : "";
    parts.push(`${sign}${recap.tokensDeltaPct}% vs prior ${PERIOD_LABELS[period]}`);
  }
  if (recap.topModel) {
    parts.push(
      `top model ${recap.topModel.model} (${formatTokens(recap.topModel.totalTokens)})`,
    );
  }
  if (recap.busiestDay) {
    parts.push(
      `busiest day ${formatUtcDay(recap.busiestDay.dayStart)} (${formatTokens(
        recap.busiestDay.totalTokens,
      )})`,
    );
  }
  if (parts.length === 0) return null;
  return <p className="stats__recap">{parts.join(" · ")}</p>;
}

/** The pending-chunk stand-in builds the SAME box as the mounted chart —
 * heading line plus a CHART_HEIGHT plot — so its height tracks the CSS
 * instead of asserting a hand-measured pixel count across three files. */
function ChartPlaceholder() {
  return (
    <section className="stats__section" aria-hidden>
      <h3>{" "}</h3>
      <div style={{ height: CHART_HEIGHT }} />
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats__card">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
