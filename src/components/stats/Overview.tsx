import { lazy, Suspense, useMemo } from "react";
import {
  costCoverage,
  displayProviderCost,
  formatTokens,
  tokenBreakdown,
} from "../../domain/usage";
import { CHART_HEIGHT } from "../../domain/usage/chartPalette";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import type {
  UsageStats,
  UsageStatsPeriod,
} from "../../domain/usage/history/query";
import { recapCaption, usageRecap } from "../../domain/usage/recap";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { Weeks } from "./Weeks";

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
  // The recap and its sentence are both domain calls — the component only
  // decides WHEN to compute (mounted means the Overview tab is selected).
  const caption = useMemo(
    () => recapCaption(usageRecap(events, period, now, stats), period),
    [events, period, now, stats],
  );
  return (
    <>
      <div className="stats__summary">
        {/* The headline number with what it is MADE of. A bare total hides
            the split that explains the bill — cache reads usually dominate
            it and are priced differently — and until now that split lived
            only in small print inside the Models and Sessions rows. */}
        <Summary
          label="Tokens"
          value={formatTokens(stats.totals.totalTokens)}
          detail={tokenBreakdown(stats.totals.tokens)}
        />
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
      {caption !== "" && <p className="stats__recap">{caption}</p>}
      <p className="stats__coverage">
        {costCoverage(stats.costSessionCount, stats.sessionCount)}
      </p>
      {/* Period-independent by design: fixed UTC weeks under the rolling
          period's numbers, visible whatever range is selected. */}
      <Weeks events={events} now={now} />
    </>
  );
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

function Summary({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  /** What the headline is made of, when it has parts worth naming. */
  detail?: string;
}) {
  return (
    <div className="stats__card">
      <span>{label}</span>
      <b>{value}</b>
      {detail !== undefined && detail !== "" && (
        <small className="stats__card-detail">{detail}</small>
      )}
    </div>
  );
}
