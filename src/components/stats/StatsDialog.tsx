import { useState } from "react";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import { formatAge, formatTokens } from "../../domain/usage";
import {
  queryUsageStats,
  type UsageStatsPeriodDays,
  type UsageStatsRow,
} from "../../domain/usage/history";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";

const PERIODS: readonly { days: UsageStatsPeriodDays; label: string }[] = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

/** Global usage analytics has its own app surface: it is observational data,
 * not a setting, and it spans every workspace and CLI. */
export function StatsDialog({ onClose }: { onClose(): void }) {
  useEscape(onClose);
  return (
    <ModalOverlay>
      <div
        className="form stats-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Usage statistics"
      >
        <div className="stats-dialog__head">
          <h2 className="form__title stats-dialog__title">Usage statistics</h2>
          <CloseButton label="Close usage statistics" onClick={onClose} />
        </div>
        <div className="stats-dialog__body">
          <UsageStats />
        </div>
        <div className="confirm__actions">
          <button type="button" className="form__create" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/** Detailed local usage analytics. Account-limit windows deliberately remain
 * in the top-bar popover; this view consumes only the durable pane ledger. */
export function UsageStats() {
  const history = useUsageHistorySnapshot();
  const [period, setPeriod] = useState<UsageStatsPeriodDays>(7);
  const now = Date.now();
  const stats = queryUsageStats(history.events, period, now);

  return (
    <div className="stats">
      <div className="stats__head">
        <p className="stats__intro">
          Local token and cost history across every CLI and workspace. Retained for 90
          days.
        </p>
        <div className="stats__period" aria-label="Statistics period">
          {PERIODS.map((candidate) => (
            <button
              key={candidate.days}
              type="button"
              className={candidate.days === period ? "stats__period--active" : ""}
              aria-pressed={candidate.days === period}
              onClick={() => setPeriod(candidate.days)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>

      {!history.ready ? (
        <p className="stats__empty">Loading usage history…</p>
      ) : history.error && history.events.length === 0 ? (
        <p className="stats__empty" role="alert">
          Usage history is unavailable: {history.error}
        </p>
      ) : stats.eventCount === 0 ? (
        <p className="stats__empty">No usage recorded in this period yet.</p>
      ) : (
        <>
          {history.error && (
            <p className="stats__warning">
              Some history could not be loaded: {history.error}
            </p>
          )}
          <div className="stats__summary">
            <Summary label="Tokens" value={formatTokens(stats.totals.totalTokens)} />
            <Summary
              label="Cost"
              value={displayCost(
                stats.totals.costUsd,
                stats.totals.pricedEvents,
                stats.totals.estimatedCostUsd,
              )}
            />
            <Summary label="Sessions" value={String(stats.sessionCount)} />
          </div>
          <p className="stats__coverage">
            {costCoverage(stats.totals.pricedEvents, stats.totals.unpricedEvents)}
          </p>

          <StatsTable title="Models" rows={stats.byModel} now={now} mode="model" />
          <StatsTable title="Sessions" rows={stats.sessions} now={now} mode="session" />
        </>
      )}
    </div>
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

function StatsTable({
  title,
  rows,
  now,
  mode,
}: {
  title: string;
  rows: UsageStatsRow[];
  now: number;
  mode: "model" | "session";
}) {
  if (rows.length === 0) return null;
  return (
    <section className="stats__section">
      <h3>{title}</h3>
      <div className="stats__table" role="table" aria-label={title}>
        {rows.map((row) => (
          <div className="stats__row" role="row" key={row.key}>
            <span className="stats__identity" role="cell">
              <b>
                {mode === "model"
                  ? row.model || "Unknown model"
                  : row.paneName || shortSession(row.sessionId)}
              </b>
              <small>
                {mode === "model"
                  ? row.agent
                  : [row.workspaceName, row.agent, shortSession(row.sessionId)]
                      .filter(Boolean)
                      .join(" · ")}
              </small>
            </span>
            <span className="stats__tokens" role="cell">
              {formatTokens(row.totalTokens)}
              <small>{tokenBreakdown(row)}</small>
            </span>
            <span className="stats__cost" role="cell">
              {displayCost(row.costUsd, row.pricedEvents, row.estimatedCostUsd)}
              <small>{formatAge(row.lastOccurredAt, now)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function tokenBreakdown(row: UsageStatsRow): string {
  const values = [
    row.tokens.input !== undefined ? `↑${formatTokens(row.tokens.input)}` : "",
    row.tokens.output !== undefined ? `↓${formatTokens(row.tokens.output)}` : "",
    row.tokens.cacheRead !== undefined
      ? `cache ${formatTokens(row.tokens.cacheRead)}`
      : "",
  ].filter(Boolean);
  return values.join(" · ");
}

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function displayCost(
  value: number,
  pricedEvents: number,
  estimatedUsd: number,
): string {
  if (pricedEvents === 0) return "—";
  return `${estimatedUsd > 0 ? "≈" : ""}${formatCost(value)}`;
}

function costCoverage(priced: number, unpriced: number): string {
  if (unpriced === 0) {
    return "Cost uses provider reports; recognized Codex models use versioned API estimates.";
  }
  if (priced === 0) {
    return "Cost unavailable for these models or subscription-backed sessions.";
  }
  return `${unpriced} usage event${unpriced === 1 ? "" : "s"} had no reliable price. Estimated amounts are API-equivalent, not subscription charges.`;
}

function shortSession(value: string | undefined): string {
  if (!value) return "Unknown session";
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
