import { useMemo, useState, type ReactElement } from "react";
import { useUsage } from "../../app/useUsage";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import { useAgents } from "../../app/useAgents";
import { usageSeriesColors } from "../../presentation/usagePalette";
import { useWindowReports } from "../../app/useWindowReports";
import {
  latestOccurredAt,
  queryUsageStats,
  type UsageStatsPeriod,
} from "../../domain/usage/history/query";
import type { StatsTab } from "../../domain/usage/statsTabs";
import {
  STATS_DIALOG,
  statsHeaderView,
  statsPanelView,
} from "../../presentation/stats/statsDialogView";
import { statsTabStep } from "../../presentation/stats/statsTabs";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { Achievements } from "./Achievements";
import { Overview } from "./Overview";
import { Providers } from "./Providers";
import { StatsTable } from "./StatsTable";
import { StreakBadge } from "./StreakBadge";

/** Global usage analytics has its own app surface: it is observational data,
 * not a setting, and it spans every workspace and CLI. The tab is CONTROLLED
 * by the app-layer owner (openStats/closeStats/selectStatsTab), so a deep
 * link can land on a tab whether or not the dialog is already open. */
export function StatsDialog({
  tab,
  onSelectTab,
  onClose,
  canClose = true,
}: {
  tab: StatsTab;
  onSelectTab(tab: StatsTab): void;
  onClose(): void;
  /** False while a transaction is stacked over this dialog: `onClose` refuses
   * then, so Escape must not be claimed either. */
  canClose?: boolean;
}) {
  useEscape(onClose, canClose);
  return (
    <ModalOverlay>
      <div
        className="form stats-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={STATS_DIALOG.title}
      >
        <div className="stats-dialog__head">
          <h2 className="form__title stats-dialog__title">{STATS_DIALOG.title}</h2>
          <CloseButton label={STATS_DIALOG.close} onClick={onClose} />
        </div>
        <div className="stats-dialog__body">
          <UsageStats tab={tab} onSelectTab={onSelectTab} />
        </div>
        <div className="confirm__actions stats-dialog__actions">
          <StreakBadge />
          <button type="button" className="form__create" onClick={onClose} autoFocus>
            {STATS_DIALOG.done}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/** Detailed local usage analytics. Account-limit windows deliberately remain
 * in the top-bar popover; this view consumes the durable pane ledger plus
 * the live account snapshot for the Limits tab. The period switcher is
 * global; the Limits tab ignores it (subscription windows run on the
 * provider's clock) and achievements are all-time by definition. Period
 * aggregates are memoized on their inputs — a ledger append recomputes them
 * once, not once per render. What the shell shows is settled in
 * presentation/stats/statsDialogView.ts. */
export function UsageStats({
  tab,
  onSelectTab,
}: {
  tab: StatsTab;
  onSelectTab(tab: StatsTab): void;
}) {
  const history = useUsageHistorySnapshot();
  // One map for every tab, so the chart, the weeks and the provider cards
  // can never disagree on a hue.
  const { agents } = useAgents();
  const { ledger } = history;
  const seriesColors = useMemo(() => usageSeriesColors(ledger.events, agents), [ledger, agents]);
  const { accounts } = useUsage();
  const reports = useWindowReports();
  const [period, setPeriod] = useState<UsageStatsPeriod>(7);
  // THE tab body's one clock: stable between 30s ticks, so it sits in every
  // memo's deps — aggregates, captions and bars all agree on the same now,
  // and a reset passing while the dialog idles demotes the whole card. The
  // ledger's newest instant floors it, so an append seconds after a tick is
  // inside the queries' `<= now` bound immediately.
  const latest = useMemo(
    () => latestOccurredAt(ledger.events),
    [ledger],
  );
  const now = useWallClock(latest);
  const stats = useMemo(
    () => queryUsageStats(ledger.events, period, now),
    [ledger, period, now],
  );
  const header = statsHeaderView(tab, period);
  const panel = statsPanelView(tab, {
    ready: history.ready,
    error: history.error,
    hasRows: ledger.events.length > 0,
    periodEvents: stats.eventCount,
    perModelSince: history.perModelSince,
    firstOccurredAt: stats.firstOccurredAt,
  });

  /** The tab body. The switch is exhaustive — a new tab id fails to compile
   * here until it brings a body. */
  const tabBody = (current: StatsTab, title: string, note: string | null): ReactElement => {
    switch (current) {
      case "overview":
        return (
          <Overview
            ledger={ledger}
            colors={seriesColors}
            stats={stats}
            period={period}
            now={now}
          />
        );
      case "limits":
        return (
          <Providers
            accounts={accounts}
            ledger={ledger}
            colors={seriesColors}
            reportsByKey={reports.byKey}
            now={now}
          />
        );
      case "models":
        return (
          <>
            <StatsTable title={title} rows={stats.byModel} now={now} mode="model" />
            {note !== null && <p className="stats__coverage">{note}</p>}
          </>
        );
      case "sessions":
        return <StatsTable title={title} rows={stats.sessions} now={now} mode="session" />;
      case "achievements":
        return <Achievements ledger={ledger} />;
    }
  };

  return (
    <div className="stats">
      <div className="stats__head">
        <p className="stats__intro">{STATS_DIALOG.intro}</p>
        <div
          className={`stats__period${header.periodIdle ? " stats__period--idle" : ""}`}
          // role=group makes the label perceivable — on a bare div (implicit
          // role generic) aria-label is ignored by assistive tech.
          role="group"
          aria-label={STATS_DIALOG.periodGroup}
          aria-disabled={header.periodIdle}
        >
          {header.periods.map((candidate) => (
            <button
              key={candidate.label}
              type="button"
              className={candidate.active ? "stats__period--active" : ""}
              aria-pressed={candidate.active}
              disabled={header.periodIdle}
              onClick={() => setPeriod(candidate.period)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>
      {/* The ARIA tabs pattern in full: roving tabIndex (one tab stop for
          the strip, arrows move within it) and an explicit tab↔panel
          association — without these a screen reader hears "tab, selected"
          with no panel to land on. */}
      <div
        className="stats__tabs"
        role="tablist"
        aria-label={STATS_DIALOG.tabList}
        onKeyDown={(keyEvent) => {
          const next = statsTabStep(tab, keyEvent.key);
          if (next === null) return;
          keyEvent.preventDefault();
          onSelectTab(next);
          document.getElementById(`stats-tab-${next}`)?.focus();
        }}
      >
        {header.tabs.map((candidate) => (
          <button
            key={candidate.id}
            id={`stats-tab-${candidate.id}`}
            type="button"
            role="tab"
            aria-selected={candidate.active}
            aria-controls="stats-tabpanel"
            tabIndex={candidate.active ? 0 : -1}
            className={`stats__tab${candidate.active ? " stats__tab--active" : ""}`}
            onClick={() => onSelectTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      <div
        id="stats-tabpanel"
        role="tabpanel"
        aria-labelledby={`stats-tab-${tab}`}
        className="stats__tabpanel"
      >
        {panel.kind === "loading" ? (
          <p className="stats__empty">{panel.text}</p>
        ) : panel.kind === "unavailable" ? (
          <p className="stats__empty kd-selectable" role="alert">
            {panel.text}
          </p>
        ) : (
          <>
            {panel.warning !== null && <p className="stats__warning kd-selectable">{panel.warning}</p>}
            {panel.kind === "empty" ? (
              <p className="stats__empty">{panel.text}</p>
            ) : (
              tabBody(panel.tab, panel.title, panel.note)
            )}
          </>
        )}
      </div>
    </div>
  );
}
