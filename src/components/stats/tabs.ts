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
 * the period switcher (with the period-empty state) applies only to
 * period-scoped ones. Providers run on the provider's clock; achievements
 * are all-time by definition. */
export type StatsTabData = "period-ledger" | "all-ledger" | "live-accounts";

export const TAB_SPECS: Record<StatsTab, { label: string; data: StatsTabData }> = {
  overview: { label: "Overview", data: "period-ledger" },
  providers: { label: "Providers", data: "live-accounts" },
  models: { label: "Models", data: "period-ledger" },
  sessions: { label: "Sessions", data: "period-ledger" },
  achievements: { label: "Achievements", data: "all-ledger" },
};

export const STATS_TABS: readonly { id: StatsTab; label: string }[] =
  STATS_TAB_IDS.map((id) => ({ id, label: TAB_SPECS[id].label }));

/** Derived, not hand-listed: a tab is period-independent exactly when its
 * data is not period-scoped. */
export const PERIODLESS_TABS: readonly StatsTab[] = STATS_TAB_IDS.filter(
  (id) => TAB_SPECS[id].data !== "period-ledger",
);
