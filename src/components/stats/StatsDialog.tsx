import { useState } from "react";
import { useUsage } from "../../app/useUsage";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import {
  displayProviderCost,
  formatAge,
  formatPct,
  formatTokens,
  formatUtcDay,
  windowLabel,
  windowLevel,
  windowResetCaption,
  type AccountUsage,
} from "../../domain/usage";
import {
  queryUsageStats,
  type UsageEventV2,
  type UsageStatsPeriod,
  type UsageStatsRow,
} from "../../domain/usage/history";
import {
  providerWindowGroups,
  type ProviderWindowLedger,
  type ProviderWindowRow,
} from "../../domain/usage/providerWindows";
import {
  achievementExact,
  achievementProgress,
  achievementRequirement,
  earnedAchievements,
  lockedAchievements,
  nextAchievements,
  usageAchievementLadders,
  type UsageAchievement,
} from "../../domain/usage/achievements";
import { usageRecap, type UsageRecap } from "../../domain/usage/recap";
import { UsageWindowBar } from "../usage/UsageWindowBar";
import { StreakBadge } from "./StreakBadge";
import { PERIODLESS_TABS, STATS_TABS, type StatsTab } from "./tabs";
import { UsageChart } from "./UsageChart";
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
        aria-label="Usage statistics"
      >
        <div className="stats-dialog__head">
          <h2 className="form__title stats-dialog__title">Usage statistics</h2>
          <CloseButton label="Close usage statistics" onClick={onClose} />
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
 * provider's clock) and achievements are all-time by definition. */
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
  const now = Date.now();
  const stats = queryUsageStats(history.events, period, now);
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
                <UsageChart events={history.events} period={period} now={now} />
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

/** Per-provider rate-limit windows joined with ledger spend inside each
 * window's current interval — one card per provider, so the name and the
 * report age appear once instead of repeating on every window. Provider %,
 * reset countdown and the ledger numbers keep separate sources — the
 * section never derives one from the other. Period-independent by design:
 * a subscription window is the provider's clock, not the user's selected
 * range. */
function Providers({
  accounts,
  events,
  now,
}: {
  accounts: ReadonlyMap<string, AccountUsage>;
  events: readonly UsageEventV2[];
  now: number;
}) {
  const groups = providerWindowGroups(accounts, events, now);
  if (groups.length === 0) {
    return (
      <p className="stats__empty">
        No provider reports yet. Windows appear once a CLI reports its account
        limits.
      </p>
    );
  }
  return (
    <section className="stats__section">
      <h3>Providers</h3>
      <div className="stats__providers" aria-label="Providers">
        {groups.map((group) => (
          <article className="stats__provider" key={group.agent}>
            <header className="stats__provider-head">
              <b>{group.agent}</b>
              <small className={group.stale ? "usage-level--warn" : ""}>
                updated {formatAge(group.reportedAt, now)}
              </small>
            </header>
            {group.rows.map((row) => (
              <ProviderWindow key={row.id} row={row} now={now} />
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function ProviderWindow({ row, now }: { row: ProviderWindowRow; now: number }) {
  const level = windowLevel(row.window, now);
  return (
    <div
      className={`stats__window${row.expired ? " stats__window--expired" : ""}`}
    >
      <div className="stats__window-head">
        <span>{windowLabel(row.window, "long")}</span>
        <span className={level ? `usage-level--${level}` : ""}>
          {formatPct(row.window.usedPct, "used")}
        </span>
      </div>
      <UsageWindowBar window={row.window} now={now} />
      <small>{windowResetCaption(row.window, now, "long")}</small>
      {row.ledger && (
        <small>
          {row.ledger.sessionCount > 0
            ? `${formatTokens(row.ledger.totalTokens)} · ${ledgerCaption(
                row.ledger,
              )} this window`
            : "no usage this window"}
        </small>
      )}
    </div>
  );
}

function ledgerCaption(ledger: ProviderWindowLedger): string {
  const sessions = `${ledger.sessionCount} session${
    ledger.sessionCount === 1 ? "" : "s"
  }`;
  const cost = displayProviderCost(ledger.providerCostUsd, ledger.costEvents);
  return cost === "—" ? sessions : `${sessions} · ${cost}`;
}

/** The achievements tab in three sections: the goals being walked toward
 * (one per ladder, with progress) first — they are the pull; the trophy
 * case of earned badges (freshest first); and the locked tail — every tier
 * still ahead, visible but inert until its predecessor is won. */
function Achievements({ events }: { events: readonly UsageEventV2[] }) {
  const ladders = usageAchievementLadders(events);
  const inProgress = nextAchievements(ladders);
  const earned = earnedAchievements(ladders);
  const locked = lockedAchievements(ladders);
  return (
    <>
      <AchievementSection title="In progress" items={inProgress} />
      <AchievementSection title="Earned" items={earned} />
      <AchievementSection title="Locked" items={locked} future />
    </>
  );
}

function AchievementSection({
  title,
  items,
  future,
}: {
  title: string;
  items: UsageAchievement[];
  future?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="stats__section">
      <h3>{title}</h3>
      <div className="stats__achievements">
        {items.map((item) => (
          <AchievementCard key={item.id} item={item} future={future === true} />
        ))}
      </div>
    </section>
  );
}

function AchievementCard({
  item,
  future,
}: {
  item: UsageAchievement;
  future: boolean;
}) {
  const locked = item.achievedAt === null;
  return (
    <article
      className={`stats__achievement${
        locked ? " stats__achievement--locked" : ""
      }${future ? " stats__achievement--future" : ""}`}
    >
      <span className="stats__achievement-icon" aria-hidden>
        {item.icon}
      </span>
      <b>{item.title}</b>
      <small>{achievementRequirement(item)}</small>
      {!locked ? (
        <small className="stats__achievement-earned">
          earned {formatUtcDay(item.achievedAt ?? 0, true)}
        </small>
      ) : future ? null : (
        <>
          <span className="stats__achievement-progress" aria-hidden>
            <i
              style={{
                width: `${Math.min(100, (item.progress / item.threshold) * 100)}%`,
              }}
            />
          </span>
          <small>{achievementProgress(item)}</small>
        </>
      )}
      <span className="stats__achievement-tip" role="tooltip">
        <b>
          <span className="stats__achievement-tip-icon" aria-hidden>
            {item.icon}
          </span>{" "}
          {item.title}
        </b>
        <span>{achievementRequirement(item)}</span>
        <span>{achievementTipStatus(item)}</span>
      </span>
    </article>
  );
}

/** The hover tooltip's status line — exact numbers, not the card's compact
 * abbreviations. The per-metric formatting lives with the metric specs. */
function achievementTipStatus(item: UsageAchievement): string {
  if (item.achievedAt !== null) {
    return `Earned ${formatUtcDay(item.achievedAt, true)}`;
  }
  return achievementExact(item);
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
              {displayProviderCost(row.providerCostUsd, row.costEvents)}
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
