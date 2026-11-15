import { panelWindows, usageStale } from "./format";
import type { WindowReport } from "./reportJournal";
import type { UsageRow } from "./history/event";
import { usageTimeline, type TimelineGranularity, type UsageStep } from "./stats/fold";
import type { StatsMeasure } from "./stats/measure";
import type { Span } from "./stats/period";
import { DAY_MS } from "./time";
import { windowExpired, type AccountUsage, type UsageWindow } from "./usage";
import { accountWindowForecasts, type WindowForecast } from "./windowForecast";
import { earlierWindows, type EarlierWindow } from "./windowHistory";

/**
 * The Stats Limits view — one row per provider rate-limit window,
 * joining the provider's own account report (how much of the limit is gone)
 * with the durable event ledger (what this machine actually spent inside
 * that window). The two sides stay labeled as such: neither is ever derived
 * from the other.
 */

export interface ProviderWindowRow {
  /** Unique within one snapshot — two windows sharing a duration and scope
   * (codex can report several duration-less account windows) still get
   * distinct identities, so list rendering never collides. */
  id: string;
  agent: string;
  window: UsageWindow;
  /** The window's journal series and forecast, from THE one join
   * ([`accountWindowForecasts`]) — the card renders them, never re-derives. */
  reports: readonly WindowReport[];
  forecast: WindowForecast;
  /** When the account report carrying this window arrived. */
  reportedAt: number;
  /** The reset instant has passed: the report describes the PREVIOUS
   * window, and the current one's boundaries are unknown. */
  expired: boolean;
  /** The report aged past the trust threshold — numbers render demoted. */
  stale: boolean;
  /** The window's own span on the calendar, start to reset ([`windowSpan`]). */
  span: Span | null;
  /** This machine's usage inside the span so far, in the measure asked for,
   * step by step on the reader's calendar ([`windowSteps`]) — quiet steps
   * included, so a gap reads as one. Null without a span. */
  usage: UsageStep[] | null;
  /** The window's earlier instances the journal still holds. */
  earlier: EarlierWindow[];
}

/**
 * A window's span — from its start to its reset — when it can be placed on
 * the calendar: alive, with a reset and a length, and unscoped. A scoped
 * limit (one model, one bucket) cannot claim this machine's unscoped usage
 * as its own; and "since the last known reset" is no fallback for an
 * expired one — a long-expired 5h window once rendered a week of usage as
 * its own.
 */
export function windowSpan(window: UsageWindow, now: number): Span | null {
  if (window.scope !== undefined || windowExpired(window, now)) return null;
  if (window.resetsAt === null || window.windowMinutes === null) return null;
  return { from: window.resetsAt - window.windowMinutes * 60_000, to: window.resetsAt };
}

/** A window of two days or more is told by the reader's calendar days, a
 * shorter one by the hour. */
export function windowSteps(span: Span): TimelineGranularity {
  return span.to - span.from >= 2 * DAY_MS ? "day" : "hour";
}

/** One provider's card: identity and report freshness once, windows inside.
 * The grouping is domain data, not a view fold — every row of a group comes
 * from the same account report by construction. */
export interface ProviderWindowGroup {
  agent: string;
  reportedAt: number;
  stale: boolean;
  rows: ProviderWindowRow[];
  /** Every window this account reported has since reset, so nothing here
   * describes the present. A domain question, not a rendering one — a
   * `keepdeck status` printer needs the same answer to know whether to
   * qualify the percentages it prints. Guaranteed meaningful because a
   * group with no rows is never emitted; `[].every()` would say yes. */
  idle: boolean;
}

/** Every reported provider as a group: providers alphabetical, each
 * provider's windows account-wide first, shortest first (the panel order
 * users already know from the chip popover). */
export function providerWindowGroups(
  accounts: ReadonlyMap<string, AccountUsage>,
  events: readonly UsageRow[],
  byKey: ReadonlyMap<string, readonly WindowReport[]>,
  now: number,
  measure: StatsMeasure,
): ProviderWindowGroup[] {
  const groups: ProviderWindowGroup[] = [];
  for (const agent of [...accounts.keys()].sort()) {
    const account = accounts.get(agent);
    if (account?.kind !== "reported") continue;
    const own = events.filter((event) => event.agent === agent);
    const windows = panelWindows(account);
    const forecasts = accountWindowForecasts(agent, account, byKey, now);
    const rows = windows.flatMap((window, index): ProviderWindowRow[] => {
      // panelWindows sorts a shallow copy, so object identity survives
      // into the join's map, minted over the account's own order. If
      // that invariant ever breaks, drop the ROW — the same degradation
      // the popover chose — never throw the whole tab.
      const joined = forecasts.get(window);
      if (!joined) return [];
      return [
        {
          id: `${joined.key}\0${index}`,
          agent,
          window,
          reports: joined.reports,
          forecast: joined.forecast,
          reportedAt: account.reportedAt,
          expired: windowExpired(window, now),
          stale: usageStale(account.reportedAt, now),
          ...windowUsage(window, own, now, measure),
          earlier: earlierWindows(joined.reports, window),
        },
      ];
    });
    // A card with zero rows has nothing to say — headless, it would render
    // a name over nothing AND suppress the honest "no provider reports
    // yet" empty state. One guard covers both ways rows can vanish: an
    // empty report (normalizers never send one; enforced, not assumed)
    // and the identity-miss drop above.
    if (rows.length === 0) continue;
    groups.push({
      agent,
      reportedAt: account.reportedAt,
      stale: usageStale(account.reportedAt, now),
      rows,
      idle: rows.every((row) => row.expired),
    });
  }
  return groups;
}

function windowUsage(
  window: UsageWindow,
  own: readonly UsageRow[],
  now: number,
  measure: StatsMeasure,
): Pick<ProviderWindowRow, "span" | "usage"> {
  const span = windowSpan(window, now);
  if (span === null) return { span, usage: null };
  const sofar = { from: span.from, to: Math.min(now, span.to) + 1 };
  return { span, usage: usageTimeline(own, sofar, windowSteps(span), measure) };
}
