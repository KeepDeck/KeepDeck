import {
  displayCost,
  formatAge,
  formatTokens,
  tokenBreakdown,
} from "../../domain/usage";
import type { UsageStatsRow } from "../../domain/usage/history/query";
import { statsRowIdentity, type StatsTableMode } from "../../presentation/stats/statsRowView";

/** The Models/Sessions drill-down table — identity, tokens with an in/out
 * breakdown, estimated cost with the row's last-seen age. */
export function StatsTable({
  title,
  rows,
  now,
  mode,
}: {
  title: string;
  rows: UsageStatsRow[];
  now: number;
  mode: StatsTableMode;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="stats__section">
      <h3>{title}</h3>
      <div className="stats__table" role="table" aria-label={title}>
        {rows.map((row) => {
          const identity = statsRowIdentity(row, mode);
          return (
            <div className="stats__row" role="row" key={row.key}>
              <span className="stats__identity" role="cell">
                <b>{identity.name}</b>
                <small>{identity.detail}</small>
              </span>
              <span className="stats__tokens" role="cell">
                {formatTokens(row.totalTokens)}
                <small>{tokenBreakdown(row.tokens)}</small>
              </span>
              <span className="stats__cost" role="cell">
                {displayCost(row)}
                <small>{formatAge(row.lastOccurredAt, now)}</small>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
