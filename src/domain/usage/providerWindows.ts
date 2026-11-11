import { panelWindows, usageStale } from "./format";
import type { WindowReport } from "./reportJournal";
import type { CostTally, UsageRow } from "./history/event";
import { dimensionKey } from "./stats/dimensions";
import { breakdown, statsTotals, type BreakdownRow } from "./stats/fold";
import { windowExpired, type AccountUsage, type UsageWindow } from "./usage";
import { accountWindowForecasts, type WindowForecast } from "./windowForecast";

/**
 * The Stats Limits view — one row per provider rate-limit window,
 * joining the provider's own account report (how much of the limit is gone)
 * with the durable event ledger (what this machine actually spent inside
 * that window). The two sides stay labeled as such: neither is ever derived
 * from the other.
 */

export interface ProviderWindowLedger extends CostTally {
  totalTokens: number;
  sessionCount: number;
  /** The sessions that spent inside the window, the biggest first — local
   * spend, never each session's share of the provider's percentage. */
  sessions: BreakdownRow[];
}

/** How many sessions a window names before folding the rest. */
export const WINDOW_SESSIONS_TOP = 3;

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
  /** Ledger spend inside the window's current interval — null when the
   * interval is unknowable: an expired window, no reset instant, an
   * unstated duration, or a scoped window (a model- or bucket-scoped limit
   * cannot be joined to unscoped ledger events without claiming other
   * models' spend as its own). A field report proved "spend since the last
   * known reset" is NOT an acceptable fallback: a long-expired 5h window
   * rendered a week of usage as its own. */
  ledger: ProviderWindowLedger | null;
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
): ProviderWindowGroup[] {
  const groups: ProviderWindowGroup[] = [];
  for (const agent of [...accounts.keys()].sort()) {
    const account = accounts.get(agent);
    if (account?.kind !== "reported") continue;
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
          ledger: windowLedger(agent, window, events, now),
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

function windowLedger(
  agent: string,
  window: UsageWindow,
  events: readonly UsageRow[],
  now: number,
): ProviderWindowLedger | null {
  if (window.scope !== undefined) return null;
  if (windowExpired(window, now)) return null;
  if (window.resetsAt === null || window.windowMinutes === null) return null;
  const start = window.resetsAt - window.windowMinutes * 60_000;
  const inside = events.filter((event) => event.agent === agent && event.occurredAt >= start && event.occurredAt <= now);
  const { sessions, outputTokens: _output, ...totals } = statsTotals(inside);
  return {
    ...totals,
    sessionCount: sessions,
    sessions: breakdown(inside, [], (event) => dimensionKey("session", event), WINDOW_SESSIONS_TOP),
  };
}
