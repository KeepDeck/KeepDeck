import type { UsageEventV2 } from "./event";
import type { UsageLedger } from "./ledger";

/** A ledger view over `events` — a fresh view per call, as the history
 * manager mints one for every change of its events. */
export function ledgerOf(events: readonly UsageEventV2[], version = 1): UsageLedger {
  return { events, version };
}
