import { panelWindows } from "./format";
import {
  addMoney,
  tokenTotal,
  usageSessionKey,
  type UsageEventV2,
} from "./history";
import type { AccountUsage, UsageWindow } from "./usage";

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
  agent: string;
  window: UsageWindow;
  /** When the account report carrying this window arrived. */
  reportedAt: number;
  /** Ledger spend inside the window's current interval — null when the
   * interval is unknowable: no reset instant, an unstated duration, or a
   * scoped window (a model- or bucket-scoped limit cannot be joined to
   * unscoped ledger events without claiming other models' spend as its
   * own). */
  ledger: ProviderWindowLedger | null;
}

/** Every reported provider's windows with their ledger joins: providers
 * alphabetical, each provider's windows account-wide first, shortest first
 * (the panel order users already know from the chip popover). */
export function providerWindowRows(
  accounts: ReadonlyMap<string, AccountUsage>,
  events: readonly UsageEventV2[],
  now: number,
): ProviderWindowRow[] {
  const rows: ProviderWindowRow[] = [];
  for (const agent of [...accounts.keys()].sort()) {
    const account = accounts.get(agent);
    if (account?.kind !== "reported") continue;
    for (const window of panelWindows(account)) {
      rows.push({
        agent,
        window,
        reportedAt: account.reportedAt,
        ledger: windowLedger(agent, window, events, now),
      });
    }
  }
  return rows;
}

/** Where the window's CURRENT interval starts. A passed reset instant is
 * still useful: everything after it belongs to the successor window, so
 * "spend since the last known reset" stays honest while the account waits
 * for a fresh report. */
function windowStart(window: UsageWindow, now: number): number | null {
  if (window.resetsAt === null) return null;
  if (window.resetsAt <= now) return window.resetsAt;
  if (window.windowMinutes === null) return null;
  return window.resetsAt - window.windowMinutes * 60_000;
}

function windowLedger(
  agent: string,
  window: UsageWindow,
  events: readonly UsageEventV2[],
  now: number,
): ProviderWindowLedger | null {
  if (window.scope !== undefined) return null;
  const start = windowStart(window, now);
  if (start === null) return null;
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
