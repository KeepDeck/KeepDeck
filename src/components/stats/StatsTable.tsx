import {
  displayProviderCost,
  formatAge,
  formatTokens,
} from "../../domain/usage";
import type { UsageStatsRow } from "../../domain/usage/history";

/** The Models/Sessions drill-down table — identity, tokens with an in/out
 * breakdown, provider cost with the row's last-seen age. */
export function StatsTable({
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

function shortSession(value: string | undefined): string {
  if (!value) return "Unknown session";
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
