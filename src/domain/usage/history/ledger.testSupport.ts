import type { UsageRow } from "./event";
import type { UsageLedger } from "./ledger";

/** A ledger view over `events` — a fresh view per call, as the history
 * manager mints one for every change of its events. */
export function ledgerOf(events: readonly UsageRow[], version = 1): UsageLedger {
  return { events, version };
}
