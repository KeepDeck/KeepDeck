import { segmentStep } from "@keepdeck/ui-kit";
import { STATS_TAB_IDS, type StatsTab } from "../../domain/usage/statsTabs";

/**
 * THE per-tab policy table — the one home of every per-tab decision the
 * dialog makes, its name included. The ids and type live in the domain
 * (statsTabs.ts) so deep-link producers can speak them; everything view-side
 * hangs off this exhaustive Record, so a new tab fails to compile until it
 * declares its label AND its data policy — and the switchboard's exhaustive
 * body switch fails until it brings a body.
 */

/** What a tab renders from — this single field decides both gates the
 * dialog applies: a dead ledger blocks every ledger-backed tab, and the
 * period-empty state applies only to tabs whose WHOLE body is
 * period-scoped. Limits run on the provider's clock; achievements are
 * all-time by definition. `period-lens` is a period-CONSUMING view over
 * the full ledger (Overview: cards and chart follow the switcher, the
 * Weeks block deliberately does not) — an empty period must never hide
 * it, only a dead ledger may. */
export type StatsTabData =
  | "period-ledger"
  | "period-lens"
  | "all-ledger"
  | "live-accounts";

export interface StatsTabSpec {
  label: string;
  data: StatsTabData;
  /** What a period-independent tab says its numbers cover instead. */
  note?: string;
  /** The tab's numbers narrow to the workspace the reader picked. */
  scoped?: true;
  /** A destination reached from a door — the footer, Weekly, a deep link —
   * rather than a tab of the strip. */
  offStrip?: true;
}

export const TAB_SPECS: Record<StatsTab, StatsTabSpec> = {
  overview: { label: "Overview", data: "period-lens", scoped: true },
  limits: { label: "Limits", data: "live-accounts", note: "Account-wide · each window runs on its provider's clock" },
  weekly: { label: "Weekly", data: "all-ledger", note: "Calendar weeks, local time · all workspaces" },
  breakdown: { label: "Breakdown", data: "period-ledger", scoped: true },
  achievements: { label: "Achievements", data: "all-ledger", offStrip: true },
};

/** Derived, not hand-listed: does the tab read the period switcher? */
export function consumesPeriod(data: StatsTabData): boolean {
  return data === "period-ledger" || data === "period-lens";
}

/** A tab is period-independent exactly when it never reads the switcher. */
export function periodless(tab: StatsTab): boolean {
  return !consumesPeriod(TAB_SPECS[tab].data);
}

/** The tabs of the strip, in order — every tab but the off-strip ones. */
export const STRIP_TABS: readonly StatsTab[] = STATS_TAB_IDS.filter((id) => TAB_SPECS[id].offStrip !== true);

/** The tab an arrow key selects from `current`: the next or previous one of
 * the strip, wrapping, and the ends on Home and End — the strip's one
 * traversal, shared with every row of choices (ui-kit segmentStep). Null for
 * any other key, and while an off-strip destination is shown. */
export function statsTabStep(current: StatsTab, key: string): StatsTab | null {
  const index = STRIP_TABS.indexOf(current);
  if (index === -1) return null;
  const next = segmentStep(key, index, STRIP_TABS.map(() => false));
  return next === null ? null : (STRIP_TABS[next] ?? null);
}

/** Where leaving an off-strip destination goes: the strip tab it was
 * opened from. */
export function returnTab(current: StatsTab, from: StatsTab): StatsTab {
  return TAB_SPECS[current].offStrip === true ? from : current;
}
