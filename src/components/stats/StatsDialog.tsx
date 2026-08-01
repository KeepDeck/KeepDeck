import { useMemo, useState, type ReactElement } from "react";
import { useUsage } from "../../app/useUsage";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import { PERIOD_LABELS, USAGE_PERIODS } from "../../domain/usage";
import {
  latestOccurredAt,
  queryUsageStats,
  type UsageStatsPeriod,
} from "../../domain/usage/history/query";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { Achievements } from "./Achievements";
import { Overview } from "./Overview";
import { Providers } from "./Providers";
import { StatsTable } from "./StatsTable";
import { StreakBadge } from "./StreakBadge";
import type { StatsTab } from "../../domain/usage/statsTabs";
import { PERIODLESS_TABS, STATS_TABS, TAB_SPECS } from "./tabs";

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
  // and a reset passing while the dialog idles demotes the whole card. The
  // ledger's newest instant floors it, so an append seconds after a tick is
  // inside the queries' `<= now` bound immediately.
  const latest = useMemo(
    () => latestOccurredAt(history.events),
    [history.events],
  );
  const now = useWallClock(latest);
  const stats = useMemo(
    () => queryUsageStats(history.events, period, now),
    [history.events, period, now],
  );
  const periodless = PERIODLESS_TABS.includes(tab);
  /** A dead ledger blocks only the tabs that read it — Providers renders
   * from the independent account snapshot regardless. */
  const historyDead = history.error !== null && history.events.length === 0;

  /** The tab body, driven entirely by the TAB_SPECS policy table: the two
   * gates read the spec's data field (never a hand-listed tab check), and
   * the switch is exhaustive — a new tab id fails to compile here until it
   * brings a body. */
  const tabBody = (current: StatsTab): ReactElement => {
    const spec = TAB_SPECS[current];
    if (spec.data !== "live-accounts" && historyDead) {
      return (
        <p className="stats__empty" role="alert">
          Usage history is unavailable: {history.error}
        </p>
      );
    }
    if (spec.data === "period-ledger" && stats.eventCount === 0) {
      return <p className="stats__empty">No usage recorded in this period yet.</p>;
    }
    switch (current) {
      case "overview":
        return (
          <Overview
            events={history.events}
            stats={stats}
            period={period}
            now={now}
          />
        );
      case "providers":
        return <Providers accounts={accounts} events={history.events} now={now} />;
      case "models":
        return <StatsTable title="Models" rows={stats.byModel} now={now} mode="model" />;
      case "sessions":
        return (
          <StatsTable title="Sessions" rows={stats.sessions} now={now} mode="session" />
        );
      case "achievements":
        return <Achievements events={history.events} />;
    }
  };

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
          {USAGE_PERIODS.map((candidate) => (
            <button
              key={PERIOD_LABELS[candidate]}
              type="button"
              className={candidate === period ? "stats__period--active" : ""}
              aria-pressed={candidate === period}
              disabled={periodless}
              onClick={() => setPeriod(candidate)}
            >
              {PERIOD_LABELS[candidate]}
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
          {tabBody(tab)}
        </>
      )}
    </div>
  );
}
