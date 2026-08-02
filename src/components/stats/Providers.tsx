import { Fragment, useMemo } from "react";
import {
  displayProviderCost,
  formatAge,
  formatPct,
  formatTokens,
  windowLabel,
  windowLevel,
  type AccountUsage,
} from "../../domain/usage";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import {
  providerWindowGroups,
  type ProviderWindowLedger,
  type ProviderWindowRow,
} from "../../domain/usage/providerWindows";
import {
  windowReportKey,
  type WindowReport,
} from "../../domain/usage/reportJournal";
import {
  cardCaptionParts,
  windowForecast,
} from "../../domain/usage/windowForecast";
import { UsageWindowBar } from "../usage/UsageWindowBar";
import { WindowBurn } from "../usage/WindowBurn";

const NO_REPORTS: readonly WindowReport[] = [];

/** Per-provider rate-limit windows joined with ledger spend inside each
 * window's current interval — one card per provider, so the name and the
 * report age appear once instead of repeating on every window. Provider %,
 * reset countdown and the ledger numbers keep separate sources — the
 * section never derives one from the other. Period-independent by design:
 * a subscription window is the provider's clock, not the user's selected
 * range. */
export function Providers({
  accounts,
  events,
  reportsByKey,
  now,
}: {
  accounts: ReadonlyMap<string, AccountUsage>;
  events: readonly UsageEventV2[];
  /** The provider-report journal — the forecast's pace history. */
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  now: number;
}) {
  // Keyed on the SAME clock the captions below render with — a memo that
  // reads its own Date.now() froze expired/stale while the caption beside
  // them said "reset passed" (round-2 finding).
  const groups = useMemo(
    () => providerWindowGroups(accounts, events, now),
    [accounts, events, now],
  );
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
      <div className="stats__providers" role="group" aria-label="Providers">
        {groups.map((group) => (
          <article className="stats__provider" key={group.agent}>
            <header className="stats__provider-head">
              <b>{group.agent}</b>
              <small className={group.stale ? "usage-level--warn" : ""}>
                updated {formatAge(group.reportedAt, now)}
              </small>
            </header>
            {group.rows.map((row) => (
              <ProviderWindow
                key={row.id}
                row={row}
                reports={
                  reportsByKey.get(windowReportKey(row.agent, row.window)) ??
                  NO_REPORTS
                }
                now={now}
              />
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function ProviderWindow({
  row,
  reports,
  now,
}: {
  row: ProviderWindowRow;
  reports: readonly WindowReport[];
  now: number;
}) {
  const level = windowLevel(row.window, now);
  const forecast = useMemo(
    () => windowForecast(reports, row.window, now),
    [reports, row.window, now],
  );
  const caption = cardCaptionParts(row.window, forecast, now);
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
      <WindowBurn
        agent={row.agent}
        window={row.window}
        reports={reports}
        forecast={forecast}
        now={now}
      />
      {caption.length > 0 && (
        <small>
          {caption.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && " · "}
              <span
                className={part.level ? `usage-level--${part.level}` : undefined}
              >
                {part.text}
              </span>
            </Fragment>
          ))}
        </small>
      )}
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
  // Branch on the FACT the caller holds, never on the formatter's sentinel
  // string — a reworded "no data" dash must not silently change layout.
  if (ledger.costEvents === 0) return sessions;
  return `${sessions} · ${displayProviderCost(ledger.providerCostUsd, ledger.costEvents)}`;
}
