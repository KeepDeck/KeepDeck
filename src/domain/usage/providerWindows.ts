import { panelWindows, usageStale } from "./format";
import {
  addMoney,
  tokenTotal,
  usageSessionKey,
  type UsageEventV2,
} from "./history";
import { windowExpired, type AccountUsage, type UsageWindow } from "./usage";

/**
 * The Stats "Providers" view — one row per provider rate-limit window,
 * joining the provider's own account report (how much of the limit is gone)
 * with the durable event ledger (what this machine actually spent inside
 * that window). The two sides stay labeled as such: neither is ever derived
 * from the other.
 */

export interface ProviderWindowLedger {
  totalTokens: number;
  providerCostUsd: number;
  costEvents: number;
  sessionCount: number;
}

export interface ProviderWindowRow {
  /** Unique within one snapshot — two windows sharing a duration and scope
   * (codex can report several duration-less account windows) still get
   * distinct identities, so list rendering never collides. */
  id: string;
  agent: string;
  window: UsageWindow;
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
}

/** Every reported provider as a group: providers alphabetical, each
 * provider's windows account-wide first, shortest first (the panel order
 * users already know from the chip popover). */
export function providerWindowGroups(
  accounts: ReadonlyMap<string, AccountUsage>,
  events: readonly UsageEventV2[],
  now: number,
): ProviderWindowGroup[] {
  const groups: ProviderWindowGroup[] = [];
  for (const agent of [...accounts.keys()].sort()) {
    const account = accounts.get(agent);
    if (account?.kind !== "reported") continue;
    const windows = panelWindows(account);
    groups.push({
      agent,
      reportedAt: account.reportedAt,
      stale: usageStale(account.reportedAt, now),
      rows: windows.map((window, index) => ({
        id: `${agent}\0${window.windowMinutes ?? "?"}\0${window.scope ?? ""}\0${index}`,
        agent,
        window,
        reportedAt: account.reportedAt,
        expired: windowExpired(window, now),
        stale: usageStale(account.reportedAt, now),
        ledger: windowLedger(agent, window, events, now),
      })),
    });
  }
  return groups;
}

/** The flat view of [`providerWindowGroups`] — kept for consumers that need
 * rows without card structure; one derivation, never a second grouping. */
export function providerWindowRows(
  accounts: ReadonlyMap<string, AccountUsage>,
  events: readonly UsageEventV2[],
  now: number,
): ProviderWindowRow[] {
  return providerWindowGroups(accounts, events, now).flatMap(
    (group) => group.rows,
  );
}

function windowLedger(
  agent: string,
  window: UsageWindow,
  events: readonly UsageEventV2[],
  now: number,
): ProviderWindowLedger | null {
  if (window.scope !== undefined) return null;
  if (windowExpired(window, now)) return null;
  if (window.resetsAt === null || window.windowMinutes === null) return null;
  const start = window.resetsAt - window.windowMinutes * 60_000;
  let totalTokens = 0;
  let providerCostUsd = 0;
  let costEvents = 0;
  const sessions = new Set<string>();
  for (const event of events) {
    if (event.agent !== agent) continue;
    if (event.occurredAt < start || event.occurredAt > now) continue;
    totalTokens += tokenTotal(event.tokens);
    if (event.costSource === "provider") {
      providerCostUsd = addMoney(providerCostUsd, event.costUsd);
      costEvents += 1;
    }
    sessions.add(usageSessionKey(event));
  }
  return {
    totalTokens,
    providerCostUsd,
    costEvents,
    sessionCount: sessions.size,
  };
}
