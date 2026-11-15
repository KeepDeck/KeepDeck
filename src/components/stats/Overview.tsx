import { lazy, Suspense, useMemo } from "react";
import type { AccountUsage } from "../../domain/usage";
import { CHART_HEIGHT } from "../../domain/usage/chartPalette";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import type { WindowReport } from "../../domain/usage/reportJournal";
import type { StatsDimension } from "../../domain/usage/stats/dimensions";
import type { StatsMeasure } from "../../domain/usage/stats/measure";
import type { StatsPeriod } from "../../domain/usage/stats/period";
import { limitsGlanceView, type LimitsGlanceView } from "../../presentation/stats/limitsGlanceView";
import { overviewView, type FigureView, type TopListView } from "../../presentation/stats/overviewView";
import { accountLimitsView } from "../../presentation/stats/providersView";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { UsageWindowBar } from "../usage/UsageWindowBar";

/** The chart rides its own chunk: recharts is the bundle's single largest
 * dependency (+45% gzip over the whole app), parsed at cold launch if
 * imported statically — for a chart behind a dialog tab. */
const UsageChart = lazy(() => import("./UsageChart").then((module) => ({ default: module.UsageChart })));

/** The Overview tab body: the headline band, the usage over the period in
 * the reader's measure, where and on what it went, and a glance at the
 * limits. What it says is settled
 * in presentation/stats/overviewView.ts and limitsGlanceView.ts; mounted
 * only while its tab is selected, so its views are memoized here. */
export function Overview({
  ledger,
  period,
  workspace,
  measure,
  now,
  colors,
  accounts,
  reportsByKey,
  onOpenLimits,
  onOpenBreakdown,
}: {
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  period: StatsPeriod;
  /** The workspace the reader narrowed to — the limits glance stays
   * account-wide whatever it is. */
  workspace: string | null;
  /** What the figures count: money, or tokens less cache reads. */
  measure: StatsMeasure;
  now: number;
  /** The dialog's series colours (presentation/usagePalette.ts). */
  colors: ReadonlyMap<string, string>;
  accounts: ReadonlyMap<string, AccountUsage>;
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  onOpenLimits(): void;
  onOpenBreakdown(dimension: StatsDimension): void;
}) {
  const view = useMemo(
    () => overviewView(ledger.events, { period, now, colors, workspace, measure }),
    [ledger, period, now, colors, workspace, measure],
  );
  const limits = useMemo(
    () => limitsGlanceView(accountLimitsView({ accounts, rows: ledger.events, reportsByKey, now, colors, measure }), now, colors),
    [accounts, ledger, reportsByKey, now, colors, measure],
  );
  return (
    <>
      <section className="stats__band" aria-label={view.label}>
        <div className="stats__figure stats__figure--hero">
          <span className="stats__figure-label">{view.headline.label}</span>
          <b className="stats__figure-value">{view.headline.value}</b>
          <span className="stats__figure-caption">
            {view.headline.change && (
              <span className={`stats__change stats__change--${view.headline.change.tone}`}>{view.headline.change.text}</span>
            )}
            {view.headline.caption}
          </span>
        </div>
        {view.figures.map((figure) => (
          <Figure key={figure.label} figure={figure} />
        ))}
      </section>
      <section className="stats__section stats__chart" aria-label={view.chart.title}>
        <header className="stats__chart-head">
          <h3>{view.chart.title}</h3>
          <span className="stats__legend">
            {view.legend.map((entry) => (
              <span key={entry.agent}>
                <i style={{ background: entry.color }} />
                {entry.agent}
                <b>{entry.amount}</b>
              </span>
            ))}
          </span>
        </header>
        {view.chartNote !== null ? (
          // The card keeps the chart's height: the page does not jump.
          <p className="stats__chart-empty" style={{ height: CHART_HEIGHT }}>
            {view.chartNote}
          </p>
        ) : (
          // A failed chunk load loses the chart, never the app — without a
          // boundary a rejected lazy import unwinds to the root and blanks
          // the whole window.
          <ErrorBoundary label="Statistics chart" fallback={<p className="stats__warning">{view.chartError}</p>}>
            <Suspense fallback={<div style={{ height: CHART_HEIGHT }} aria-hidden />}>
              <UsageChart view={view.chart} />
            </Suspense>
          </ErrorBoundary>
        )}
      </section>
      <div className="stats__glance">
        {view.lists.map((list) => (
          <TopList key={list.title} list={list} onOpen={() => onOpenBreakdown(list.dimension)} />
        ))}
        <LimitsGlance view={limits} now={now} onOpen={onOpenLimits} />
      </div>
      <p className="stats__coverage">{view.coverage}</p>
    </>
  );
}

function Figure({ figure }: { figure: FigureView }) {
  return (
    <div className="stats__figure">
      <span className="stats__figure-label">{figure.label}</span>
      <b className="stats__figure-value">{figure.value}</b>
      <span className="stats__figure-caption">{figure.caption}</span>
    </div>
  );
}

function TopList({ list, onOpen }: { list: TopListView; onOpen(): void }) {
  return (
    <section className="stats__top" aria-label={list.title}>
      <h3>
        {list.title}
        <button type="button" className="stats__link" onClick={onOpen}>
          {list.link}
        </button>
      </h3>
      {list.empty !== null && <p className="stats__top-empty">{list.empty}</p>}
      {list.rows.map((row) => (
        <div key={row.key} className={`stats__top-row${row.folded ? " stats__top-row--folded" : ""}`}>
          <span className="stats__top-name" title={row.title}>
            {row.name}
            {row.source !== null && <small>{row.source}</small>}
          </span>
          <b>{row.amount}</b>
        </div>
      ))}
    </section>
  );
}

function LimitsGlance({ view, now, onOpen }: { view: LimitsGlanceView; now: number; onOpen(): void }) {
  return (
    <section className="stats__top" aria-label={view.title}>
      <h3>
        {view.title}
        <button type="button" className="stats__link" onClick={onOpen}>
          {view.link}
        </button>
      </h3>
      {view.empty !== null && <p className="stats__top-empty">{view.empty}</p>}
      {view.providers.map((provider) => (
        <div key={provider.agent} className="stats__glance-provider">
          {provider.windows.map((window) => (
            <div key={window.id}>
              <div className={`stats__glance-window${window.expired ? " stats__glance-window--expired" : ""}`}>
                <span className={`stats__glance-agent${window.age ? " stats__glance-agent--age" : ""}`}>
                  {window.agent !== null && (
                    <>
                      <i style={{ background: provider.color }} />
                      {window.agent}
                    </>
                  )}
                  {window.age && <small className={`stats__glance-age ${window.age.className ?? ""}`}>{window.age.text}</small>}
                </span>
                <span className="stats__glance-label">{window.label}</span>
                <UsageWindowBar window={window.window} now={now} />
                <span className={`stats__glance-pct ${window.percent.className ?? ""}`}>{window.percent.text}</span>
                <span className="stats__glance-reset">{window.reset}</span>
              </div>
              {window.alarm && <small className={`stats__glance-note ${window.alarm.className ?? ""}`}>{window.alarm.text}</small>}
            </div>
          ))}
          {provider.age && (
            <small className={`stats__glance-age stats__glance-age--line ${provider.age.className ?? ""}`}>{provider.age.text}</small>
          )}
        </div>
      ))}
    </section>
  );
}
