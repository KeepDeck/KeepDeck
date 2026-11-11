import { lazy, Suspense, useMemo } from "react";
import type { AccountUsage } from "../../domain/usage";
import { CHART_HEIGHT } from "../../domain/usage/chartPalette";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import { providerWindowGroups } from "../../domain/usage/providerWindows";
import type { WindowReport } from "../../domain/usage/reportJournal";
import type { StatsPeriod } from "../../domain/usage/stats/period";
import { limitsGlanceView, type LimitsGlanceView } from "../../presentation/stats/limitsGlanceView";
import { overviewView, type FigureView, type TopListView } from "../../presentation/stats/overviewView";
import { providersView } from "../../presentation/stats/providersView";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { UsageWindowBar } from "../usage/UsageWindowBar";

/** The chart rides its own chunk: recharts is the bundle's single largest
 * dependency (+45% gzip over the whole app), parsed at cold launch if
 * imported statically — for a chart behind a dialog tab. */
const SpendChart = lazy(() => import("./SpendChart").then((module) => ({ default: module.SpendChart })));

/** The Overview tab body: the headline band, money over the period, where
 * and on what it went, and a glance at the limits. What it says is settled
 * in presentation/stats/overviewView.ts and limitsGlanceView.ts; mounted
 * only while its tab is selected, so its views are memoized here. */
export function Overview({
  ledger,
  period,
  now,
  colors,
  accounts,
  reportsByKey,
  onOpenLimits,
}: {
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  period: StatsPeriod;
  now: number;
  /** The dialog's series colours (presentation/usagePalette.ts). */
  colors: ReadonlyMap<string, string>;
  accounts: ReadonlyMap<string, AccountUsage>;
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  onOpenLimits(): void;
}) {
  const view = useMemo(() => overviewView(ledger.events, period, now, colors), [ledger, period, now, colors]);
  const limits = useMemo(
    () =>
      limitsGlanceView(
        providersView(providerWindowGroups(accounts, ledger.events, reportsByKey, now), now, colors),
        now,
        colors,
      ),
    [accounts, ledger, reportsByKey, now, colors],
  );
  return (
    <>
      <section className="stats__band" aria-label={view.label}>
        <div className="stats__figure stats__figure--hero">
          <span className="stats__figure-label">{view.spent.label}</span>
          <b className="stats__figure-value">{view.spent.value}</b>
          <span className="stats__figure-caption">
            {view.spent.change && (
              <span className={`stats__change stats__change--${view.spent.change.tone}`}>{view.spent.change.text}</span>
            )}
            {view.spent.caption}
          </span>
        </div>
        {view.figures.map((figure) => (
          <Figure key={figure.label} figure={figure} />
        ))}
      </section>
      {view.chart && (
        <section className="stats__section stats__chart" aria-label={view.chart.title}>
          <header className="stats__chart-head">
            <h3>{view.chart.title}</h3>
            <span className="stats__legend">
              {view.legend.map((entry) => (
                <span key={entry.agent}>
                  <i style={{ background: entry.color }} />
                  {entry.agent}
                  <b>{entry.cost}</b>
                </span>
              ))}
            </span>
          </header>
          {/* A failed chunk load loses the chart, never the app — without a
              boundary a rejected lazy import unwinds to the root and blanks
              the whole window. */}
          <ErrorBoundary label="Statistics chart" fallback={<p className="stats__warning">{view.chartError}</p>}>
            <Suspense fallback={<div style={{ height: CHART_HEIGHT }} aria-hidden />}>
              <SpendChart view={view.chart} />
            </Suspense>
          </ErrorBoundary>
        </section>
      )}
      <div className="stats__glance">
        {view.lists.map((list) => (
          <TopList key={list.title} list={list} />
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

function TopList({ list }: { list: TopListView }) {
  return (
    <section className="stats__top" aria-label={list.title}>
      <h3>{list.title}</h3>
      {list.rows.map((row) => (
        <div key={row.key} className={`stats__top-row${row.folded ? " stats__top-row--folded" : ""}`}>
          <span className="stats__top-name" title={row.title}>
            {row.name}
            {row.source !== null && <small>{row.source}</small>}
          </span>
          <b>{row.cost}</b>
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
                <span className="stats__glance-agent">
                  {window.agent !== null && (
                    <>
                      <i style={{ background: provider.color }} />
                      {window.agent}
                    </>
                  )}
                </span>
                <span className="stats__glance-label">{window.label}</span>
                <UsageWindowBar window={window.window} now={now} />
                <span className={`stats__glance-pct ${window.percent.className ?? ""}`}>{window.percent.text}</span>
                <span className="stats__glance-reset">{window.reset}</span>
              </div>
              {window.alarm && <small className={`stats__glance-note ${window.alarm.className ?? ""}`}>{window.alarm.text}</small>}
            </div>
          ))}
          {provider.stale && <small className={`stats__glance-note ${provider.stale.className ?? ""}`}>{provider.stale.text}</small>}
        </div>
      ))}
    </section>
  );
}
