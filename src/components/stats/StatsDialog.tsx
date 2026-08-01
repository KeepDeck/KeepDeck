import { useState } from "react";
import { useUsage } from "../../app/useUsage";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import {
  formatAge,
  formatPct,
  formatTokens,
  windowLabel,
  windowResetCaption,
  type AccountUsage,
  type UsageWindow,
} from "../../domain/usage";
import {
  queryUsageStats,
  type UsageEventV2,
  type UsageStatsPeriod,
  type UsageStatsRow,
} from "../../domain/usage/history";
import {
  providerWindowRows,
  type ProviderWindowLedger,
  type ProviderWindowRow,
} from "../../domain/usage/providerWindows";
import { usageRecap, type UsageRecap } from "../../domain/usage/recap";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";

const PERIODS: readonly { period: UsageStatsPeriod; label: string }[] = [
  { period: 1, label: "24h" },
  { period: 7, label: "7d" },
  { period: 30, label: "30d" },
  { period: 90, label: "90d" },
  { period: "all", label: "All" },
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
  const { accounts } = useUsage();
  const [period, setPeriod] = useState<UsageStatsPeriod>(7);
  const now = Date.now();
  const stats = queryUsageStats(history.events, period, now);

  return (
    <div className="stats">
      <div className="stats__head">
        <p className="stats__intro">
          Local token history and provider-reported cost estimates across every CLI
          and workspace.
        </p>
        <div className="stats__period" aria-label="Statistics period">
          {PERIODS.map((candidate) => (
            <button
              key={candidate.label}
              type="button"
              className={candidate.period === period ? "stats__period--active" : ""}
              aria-pressed={candidate.period === period}
              onClick={() => setPeriod(candidate.period)}
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
                stats.totals.providerCostUsd,
                stats.totals.costEvents,
              )}
            />
            <Summary label="Sessions" value={String(stats.sessionCount)} />
          </div>
          <Highlights
            recap={usageRecap(history.events, period, now)}
            period={period}
          />
          <p className="stats__coverage">
            {costCoverage(
              stats.sessions.filter((row) => row.costEvents > 0).length,
              stats.sessionCount,
            )}
          </p>

          <Providers accounts={accounts} events={history.events} now={now} />
          <StatsTable title="Models" rows={stats.byModel} now={now} mode="model" />
          <StatsTable title="Sessions" rows={stats.sessions} now={now} mode="session" />
        </>
      )}
    </div>
  );
}

/** Per-provider rate-limit windows joined with ledger spend inside each
 * window's current interval. Provider %, reset countdown and the ledger
 * numbers keep separate sources — the section never derives one from the
 * other. Period-independent by design: a subscription window is the
 * provider's clock, not the user's selected range. */
function Providers({
  accounts,
  events,
  now,
}: {
  accounts: ReadonlyMap<string, AccountUsage>;
  events: readonly UsageEventV2[];
  now: number;
}) {
  const rows = providerWindowRows(accounts, events, now);
  if (rows.length === 0) return null;
  return (
    <section className="stats__section">
      <h3>Providers</h3>
      <div className="stats__table" role="table" aria-label="Providers">
        {rows.map((row) => (
          <div className="stats__row" role="row" key={providerRowKey(row)}>
            <span className="stats__identity" role="cell">
              <b>{row.agent}</b>
              <small>{providerWindowCaption(row.window)}</small>
            </span>
            <span className="stats__tokens" role="cell">
              {row.ledger ? formatTokens(row.ledger.totalTokens) : "—"}
              <small>{row.ledger ? ledgerCaption(row.ledger) : ""}</small>
            </span>
            <span className="stats__cost" role="cell">
              {formatPct(row.window.usedPct, "used")}
              <small>{windowResetCaption(row.window, now)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function providerWindowCaption(window: UsageWindow): string {
  const label = windowLabel(window, "long");
  return window.windowMinutes !== null ? `${label} window` : label;
}

function ledgerCaption(ledger: ProviderWindowLedger): string {
  const sessions = `${ledger.sessionCount} session${
    ledger.sessionCount === 1 ? "" : "s"
  }`;
  const cost = displayCost(ledger.providerCostUsd, ledger.costEvents);
  return cost === "—" ? sessions : `${sessions} · ${cost}`;
}

function providerRowKey(row: ProviderWindowRow): string {
  return [row.agent, row.window.windowMinutes ?? "", row.window.scope ?? ""].join(
    "\0",
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
      `busiest day ${utcDayLabel(recap.busiestDay.dayStart)} (${formatTokens(
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

/** Labeled in UTC because recap day buckets are UTC days. */
function utcDayLabel(dayStart: number): string {
  return new Date(dayStart).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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
              {displayCost(row.providerCostUsd, row.costEvents)}
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

function displayCost(value: number, costEvents: number): string {
  if (costEvents === 0) return "—";
  return `≈${formatCost(value)}`;
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

function shortSession(value: string | undefined): string {
  if (!value) return "Unknown session";
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
