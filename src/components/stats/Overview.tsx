import { lazy, Suspense, useMemo } from "react";
import { CHART_HEIGHT } from "../../domain/usage/chartPalette";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import type {
  UsageStats,
  UsageStatsPeriod,
} from "../../domain/usage/history/query";
import { usageRecap } from "../../domain/usage/recap";
import { overviewView, type SummaryCardView } from "../../presentation/stats/overviewView";
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
  ledger,
  colors,
  stats,
  period,
  now,
}: {
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  /** The dialog's series colours (presentation/usagePalette.ts). */
  colors: ReadonlyMap<string, string>;
  stats: UsageStats;
  period: UsageStatsPeriod;
  now: number;
}) {
  // The component only decides WHEN to compute (mounted means the Overview
  // tab is selected); what the tab says is settled in overviewView.
  const view = useMemo(
    () => overviewView(stats, usageRecap(ledger.events, period, now, stats), period),
    [ledger, period, now, stats],
  );
  return (
    <>
      <div className="stats__summary">
        {view.cards.map((card) => (
          <Summary key={card.label} card={card} />
        ))}
      </div>
      {/* A failed chunk load loses the chart, never the app — without a
          boundary a rejected lazy import unwinds to the root and blanks
          the whole window. */}
      <ErrorBoundary
        label="Statistics chart"
        fallback={<p className="stats__warning">{view.chartError}</p>}
      >
        <Suspense fallback={<ChartPlaceholder />}>
          <UsageChart ledger={ledger} colors={colors} period={period} now={now} />
        </Suspense>
      </ErrorBoundary>
      {view.recap && <p className="stats__recap">{view.recap}</p>}
      <p className="stats__coverage">{view.coverage}</p>
      {/* Period-independent by design: fixed UTC weeks under the rolling
          period's numbers, visible whatever range is selected. */}
      <Weeks ledger={ledger} colors={colors} now={now} />
    </>
  );
}

/** The pending-chunk stand-in builds the SAME box as the mounted chart —
 * heading line plus a CHART_HEIGHT plot — so its height tracks the CSS
 * instead of asserting a hand-measured pixel count across three files. */
function ChartPlaceholder() {
  return (
    <section className="stats__section stats__chart" aria-hidden>
      <h3>{" "}</h3>
      <div style={{ height: CHART_HEIGHT }} />
    </section>
  );
}

function Summary({ card }: { card: SummaryCardView }) {
  return (
    <div className="stats__card">
      <span>{card.label}</span>
      <b>{card.value}</b>
      {card.detail && <small className="stats__card-detail">{card.detail}</small>}
    </div>
  );
}
