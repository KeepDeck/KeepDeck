import { lazy, Suspense, useMemo, useState } from "react";
import { useUsage } from "../../app/useUsage";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import {
  displayProviderCost,
  formatTokens,
  formatUtcDay,
} from "../../domain/usage";
import {
  queryUsageStats,
  type UsageStatsPeriod,
} from "../../domain/usage/history";
import { usageRecap, type UsageRecap } from "../../domain/usage/recap";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { Achievements } from "./Achievements";
import { Providers } from "./Providers";
import { StatsTable } from "./StatsTable";
import { StreakBadge } from "./StreakBadge";
import { PERIODLESS_TABS, STATS_TABS, type StatsTab } from "./tabs";

/** The chart rides its own chunk: recharts is the bundle's single largest
 * dependency (+45% gzip over the whole app), parsed at cold launch if
 * imported statically — for a chart behind a dialog tab. */
const UsageChart = lazy(() =>
  import("./UsageChart").then((module) => ({ default: module.UsageChart })),
);

const PERIODS: readonly { period: UsageStatsPeriod; label: string }[] = [
  { period: 1, label: "24h" },
  { period: 7, label: "7d" },
  { period: 30, label: "30d" },
  { period: 90, label: "90d" },
  { period: "all", label: "All" },
];

/** Global usage analytics has its own app surface: it is observational data,
 * not a setting, and it spans every workspace and CLI. The tab is CONTROLLED
 * by the app-layer owner (openStats/closeStats/selectStatsTab), so a deep
 * link can land on a tab whether or not the dialog is already open. */
export function StatsDialog({
  tab,
  onSelectTab,
  onClose,
}: {
  tab: StatsTab;
  onSelectTab(tab: StatsTab): void;
  onClose(): void;
}) {
  useEscape(onClose);
  return (
    <ModalOverlay>
      <div
        className="form stats-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Statistics"
      >
        <div className="stats-dialog__head">
          <h2 className="form__title stats-dialog__title">Statistics</h2>
          <CloseButton label="Close statistics" onClick={onClose} />
        </div>
        <div className="stats-dialog__body">
          <UsageStats tab={tab} onSelectTab={onSelectTab} />
        </div>
        <div className="confirm__actions stats-dialog__actions">
          <StreakBadge />
          <button type="button" className="form__create" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/** Detailed local usage analytics. Account-limit windows deliberately remain
 * in the top-bar popover; this view consumes the durable pane ledger plus
 * the live account snapshot for the Providers tab. The period switcher is
 * global; the Providers tab ignores it (subscription windows run on the
 * provider's clock) and achievements are all-time by definition. Period
 * aggregates are memoized on their inputs — a ledger append recomputes them
 * once, not once per render. */
export function UsageStats({
  tab,
  onSelectTab,
}: {
  tab: StatsTab;
  onSelectTab(tab: StatsTab): void;
}) {
  const history = useUsageHistorySnapshot();
  const { accounts } = useUsage();
  const [period, setPeriod] = useState<UsageStatsPeriod>(7);
  // THE tab body's one clock: stable between 30s ticks, so it sits in every
  // memo's deps — aggregates, captions and bars all agree on the same now,
  // and a reset passing while the dialog idles demotes the whole card.
  const now = useWallClock();
  const stats = useMemo(
    () => queryUsageStats(history.events, period, now),
    [history.events, period, now],
  );
  const recap = useMemo(
    () => (tab === "overview" ? usageRecap(history.events, period, now) : null),
    [tab, history.events, period, now],
  );
  const periodless = PERIODLESS_TABS.includes(tab);
  const periodEmpty = (
    <p className="stats__empty">No usage recorded in this period yet.</p>
  );
  /** A dead ledger blocks only the tabs that read it — Providers renders
   * from the independent account snapshot regardless. */
  const historyDead = history.error !== null && history.events.length === 0;
  const ledgerBlocked = (
    <p className="stats__empty" role="alert">
      Usage history is unavailable: {history.error}
    </p>
  );

  return (
    <div className="stats">
      <div className="stats__head">
        <p className="stats__intro">
          Local token history and provider-reported cost estimates across every CLI
          and workspace.
        </p>
        <div
          className={`stats__period${periodless ? " stats__period--idle" : ""}`}
          aria-label="Statistics period"
          // A switcher that silently does nothing reads as broken, so it
          // disables on period-independent tabs. Disabled, not hidden:
          // hiding would jump the header layout.
          aria-disabled={periodless}
        >
          {PERIODS.map((candidate) => (
            <button
              key={candidate.label}
              type="button"
              className={candidate.period === period ? "stats__period--active" : ""}
              aria-pressed={candidate.period === period}
              disabled={periodless}
              onClick={() => setPeriod(candidate.period)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>
      <div className="stats__tabs" role="tablist" aria-label="Statistics sections">
        {STATS_TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={candidate.id === tab}
            className={`stats__tab${candidate.id === tab ? " stats__tab--active" : ""}`}
            onClick={() => onSelectTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      {!history.ready ? (
        <p className="stats__empty">Loading usage history…</p>
      ) : (
        <>
          {history.error !== null && !historyDead && (
            <p className="stats__warning">
              Some history could not be loaded: {history.error}
            </p>
          )}
          {tab === "overview" &&
            (historyDead ? (
              ledgerBlocked
            ) : stats.eventCount === 0 ? (
              periodEmpty
            ) : (
              <>
                <div className="stats__summary">
                  <Summary
                    label="Tokens"
                    value={formatTokens(stats.totals.totalTokens)}
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
                <Suspense
                  // Same footprint as the mounted chart, so the section
                  // below doesn't jump when the chunk lands.
                  fallback={<section className="stats__section" style={{ height: 216 }} aria-hidden />}
                >
                  <UsageChart events={history.events} period={period} now={now} />
                </Suspense>
                {recap && <Highlights recap={recap} period={period} />}
                <p className="stats__coverage">
                  {costCoverage(
                    stats.sessions.filter((row) => row.costEvents > 0).length,
                    stats.sessionCount,
                  )}
                </p>
              </>
            ))}
          {tab === "providers" && (
            <Providers accounts={accounts} events={history.events} now={now} />
          )}
          {tab === "models" &&
            (historyDead ? (
              ledgerBlocked
            ) : stats.eventCount === 0 ? (
              periodEmpty
            ) : (
              <StatsTable title="Models" rows={stats.byModel} now={now} mode="model" />
            ))}
          {tab === "sessions" &&
            (historyDead ? (
              ledgerBlocked
            ) : stats.eventCount === 0 ? (
              periodEmpty
            ) : (
              <StatsTable
                title="Sessions"
                rows={stats.sessions}
                now={now}
                mode="session"
              />
            ))}
          {tab === "achievements" &&
            (historyDead ? ledgerBlocked : <Achievements events={history.events} />)}
        </>
      )}
    </div>
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
    parts.push(`${sign}${recap.tokensDeltaPct}% vs prior ${periodLabel(period)}`);
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

function periodLabel(period: UsageStatsPeriod): string {
  return PERIODS.find((candidate) => candidate.period === period)?.label ?? "";
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats__card">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function costCoverage(costSessions: number, sessionCount: number): string {
  if (costSessions === 0) {
    return "No CLI reported a cost estimate. Token totals remain available.";
  }
  if (costSessions === sessionCount) {
    return "Provider-reported API estimates, not subscription charges.";
  }
  return `Provider estimates available for ${costSessions} of ${sessionCount} sessions; unreported sessions are excluded.`;
}
