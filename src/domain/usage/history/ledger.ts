import type { UsageRow } from "./event";

/** The usage ledger as a reader sees it at one moment.
 *
 * `events` is the ledger in append order, and it is appended IN PLACE: at
 * half a million events a fresh array per append cost ~7 MB of garbage each
 * time, the webview's largest churn. So the array's identity no longer says
 * "the ledger changed". This view does: a new one is minted for every change
 * of the events and only then, with `version` counting those changes. A
 * reader that caches anything derived from the events keys the cache on the
 * view, never on `events`. */
export interface UsageLedger {
  readonly events: readonly UsageRow[];
  readonly version: number;
}

/** Every agent the ledger has EVER seen, sorted — the stable roster that
 * keys chart colours. A period-filtered agent list must never key colours:
 * that is how a period switch repaints a provider. */
export function usageAgents(events: readonly UsageRow[]): string[] {
  const agents = new Set<string>();
  for (const event of events) agents.add(event.agent);
  return [...agents].sort();
}
