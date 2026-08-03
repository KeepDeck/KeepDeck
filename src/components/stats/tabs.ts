import { STATS_TAB_IDS, type StatsTab } from "../../domain/usage/statsTabs";

/**
 * THE per-tab policy table — the one home of every per-tab decision the
 * dialog makes. The ids and type live in the domain (statsTabs.ts) so
 * deep-link producers can speak them; everything view-side hangs off this
 * exhaustive Record, so a new tab fails to compile until it declares its
 * label AND its data policy — and the switchboard's exhaustive body
 * switch fails until it brings a body.
 */

/** What a tab renders from — this single field decides both gates the
 * switchboard applies: a dead ledger blocks every ledger-backed tab, and
 * the period-empty state applies only to tabs whose WHOLE body is
 * period-scoped. Providers run on the provider's clock; achievements are
 * all-time by definition. `period-lens` is a period-CONSUMING view over
 * the full ledger (Overview: cards and chart follow the switcher, the
 * Weeks block deliberately does not) — an empty period must never hide
 * it, only a dead ledger may. */
export type StatsTabData =
  | "period-ledger"
  | "period-lens"
  | "all-ledger"
  | "live-accounts";

export const TAB_SPECS: Record<StatsTab, { label: string; data: StatsTabData }> = {
  overview: { label: "Overview", data: "period-lens" },
  providers: { label: "Providers", data: "live-accounts" },
  models: { label: "Models", data: "period-ledger" },
  sessions: { label: "Sessions", data: "period-ledger" },
  achievements: { label: "Achievements", data: "all-ledger" },
};

export const STATS_TABS: readonly { id: StatsTab; label: string }[] =
  STATS_TAB_IDS.map((id) => ({ id, label: TAB_SPECS[id].label }));

/** Derived, not hand-listed: does the tab read the period switcher? */
export function consumesPeriod(data: StatsTabData): boolean {
  return data === "period-ledger" || data === "period-lens";
}

/** A tab is period-independent exactly when it never reads the switcher. */
export const PERIODLESS_TABS: readonly StatsTab[] = STATS_TAB_IDS.filter(
  (id) => !consumesPeriod(TAB_SPECS[id].data),
);
