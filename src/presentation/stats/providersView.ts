import { formatAge, formatMoment, formatPct, windowLabel, windowLevel, windowResetCaption, type AccountUsage, type UsageWindow } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { providerWindowGroups, type ProviderWindowGroup, type ProviderWindowRow } from "../../domain/usage/providerWindows";
import type { StatsMeasure } from "../../domain/usage/stats/measure";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowVerdict } from "../../domain/usage/windowForecast";
import { seriesColorFor } from "../usagePalette";
import { reportedAgeCaption, usageLevelClass } from "../usageView";
import { limitsChartView, type LimitsChartView } from "./limitsChartView";

/**
 * The Limits tab's provider cards, settled. One card per provider, drawn
 * around its longest live window — the week a 5-hour window runs inside —
 * with the provider's other windows beside it, never as cards of their own:
 * one subscription, one card (user, 2026-11-15). The cards come riskiest
 * first. The component renders this and decides nothing.
 */

/** A piece of text and the class that colours it, if any. */
export interface ToneText {
  text: string;
  className?: string;
}

export interface ProviderWindowView {
  id: string;
  label: string;
  percent: ToneText;
  expired: boolean;
  /** For the shared window bar, which colours itself. */
  window: UsageWindow;
  /** How much of the window's time has gone, for a tick on its bar — null
   * when the window has no span to measure. */
  pace: { left: string; title: string } | null;
  /** When it resets: "resets in 5d 22h · Sat 17:00". */
  reset: string;
  /** The forecast in words; a warning carries its level's class. Null for a
   * window that has reset. */
  verdict: ToneText | null;
}

export interface ProviderCardView {
  agent: string;
  color: string;
  updated: ToneText;
  /** The report's age alone ("3h ago"), toned as `updated` — for a place
   * that already says whose report it is. */
  age: ToneText;
  /** Every window, the account's panel order: shortest first. */
  windows: ProviderWindowView[];
  /** The window the card is drawn around — the longest live one with a
   * span — or null when none is; the rest follow it as small tiles. */
  lead: ProviderWindowView | null;
  others: ProviderWindowView[];
  chart: LimitsChartView | null;
}

export type ProvidersView =
  | { kind: "empty"; text: string }
  | {
      kind: "cards";
      title: string;
      cards: ProviderCardView[];
      /** What the bars under the charts are, said once; null without bars. */
      note: string | null;
    };

const tone = (text: string, className: string | undefined): ToneText =>
  className ? { text, className } : { text };

/** What the bars count, by measure. */
const BAR_NOTES: Record<StatsMeasure, string> = {
  spend: "Bars are this machine's spend at list price, by day (by hour in a short window); the provider also counts other devices and the web.",
  tokens: "Bars are this machine's tokens less cache reads, by day (by hour in a short window); the provider also counts other devices and the web.",
};

function barsNote(cards: readonly ProviderCardView[], measure: StatsMeasure): string | null {
  const bars = cards.flatMap((card) => card.chart?.bars ?? []);
  if (bars.length === 0) return null;
  return bars.some((bar) => bar.unpriced !== "none") ? `${BAR_NOTES[measure]} ${UNPRICED_BARS}` : BAR_NOTES[measure];
}

/** Said under the bars once any of them leaves usage out of its money. */
const UNPRICED_BARS = "Usage on a model without a known price is not in a bar's height: a bar marked “+” leaves some out, a hollow one has none priced.";

function windowView(row: ProviderWindowRow, now: number): ProviderWindowView {
  const { window, span } = row;
  const verdict = row.expired ? null : windowVerdict(window, row.forecast, now);
  const elapsed = span === null ? null : Math.min(1, Math.max(0, (now - span.from) / (span.to - span.from)));
  return {
    id: row.id,
    label: windowLabel(window, "long"),
    percent: tone(formatPct(window.usedPct, "used"), usageLevelClass(windowLevel(window, now))),
    expired: row.expired,
    window,
    pace: elapsed === null ? null : { left: `${(elapsed * 100).toFixed(1)}%`, title: `${Math.round(elapsed * 100)}% of the window's time has gone` },
    reset: row.expired
      ? "reset — waiting for its next report"
      : [windowResetCaption(window, now, "long"), window.resetsAt === null ? "" : formatMoment(window.resetsAt, now)].filter(Boolean).join(" · "),
    verdict: verdict === null ? null : tone(verdict.text, usageLevelClass(verdict.level)),
  };
}

/** The longest live window with a span: the one a card is drawn around. */
function mainRow(rows: readonly ProviderWindowRow[]): ProviderWindowRow | null {
  let main: ProviderWindowRow | null = null;
  let longest = 0;
  for (const row of rows) {
    const length = row.span === null ? 0 : row.span.to - row.span.from;
    if (length > longest) {
      main = row;
      longest = length;
    }
  }
  return main;
}

const SEVERITY = { critical: 2, warn: 1 } as const;

/** How pressing a provider is, as a sort key: the severest warning its
 * forecasts give, then how soon that one runs out, then its fullest live
 * window. */
function risk(group: ProviderWindowGroup): { severity: number; outAt: number; fullest: number } {
  let severity = 0;
  let outAt = Infinity;
  let fullest = 0;
  for (const row of group.rows) {
    if (row.expired) continue;
    fullest = Math.max(fullest, row.window.usedPct);
    const { forecast } = row;
    if (forecast.kind !== "out" || forecast.level === null) continue;
    const level = SEVERITY[forecast.level];
    if (level > severity || (level === severity && forecast.outAt < outAt)) {
      severity = level;
      outAt = forecast.outAt;
    }
  }
  return { severity, outAt, fullest };
}

function byRisk(left: ProviderWindowGroup, right: ProviderWindowGroup): number {
  const a = risk(left);
  const b = risk(right);
  return b.severity - a.severity || a.outAt - b.outAt || b.fullest - a.fullest;
}

export function providersView(
  groups: readonly ProviderWindowGroup[],
  now: number,
  colors: ReadonlyMap<string, string>,
  measure: StatsMeasure,
): ProvidersView {
  if (groups.length === 0) {
    return {
      kind: "empty",
      text: "No provider reports yet. Windows appear once a CLI reports its account limits.",
    };
  }
  // Riskiest first; the groups arrive alphabetical and the sort is stable.
  const cards = [...groups].sort(byRisk).map((group): ProviderCardView => {
    const main = mainRow(group.rows);
    const stale = usageLevelClass(group.stale ? "warn" : null);
    const windows = group.rows.map((row) => windowView(row, now));
    const lead = windows.find((window) => window.id === main?.id) ?? null;
    return {
      agent: group.agent,
      color: seriesColorFor(colors, group.agent),
      updated: tone(reportedAgeCaption(group.reportedAt, now), stale),
      age: tone(formatAge(group.reportedAt, now), stale),
      windows,
      lead,
      others: windows.filter((window) => window !== lead),
      chart: main === null ? null : limitsChartView(main, group.rows.filter((row) => row !== main), now, measure),
    };
  });
  return {
    kind: "cards",
    title: "Providers",
    cards,
    note: barsNote(cards, measure),
  };
}

/** THE Limits pipeline — the accounts' windows joined with the ledger and
 * the report journal, settled as cards — in one place, so the Limits tab
 * and Overview's glance read the very same cards. */
export function accountLimitsView(input: {
  accounts: ReadonlyMap<string, AccountUsage>;
  rows: readonly UsageRow[];
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  now: number;
  colors: ReadonlyMap<string, string>;
  measure: StatsMeasure;
}): ProvidersView {
  return providersView(
    providerWindowGroups(input.accounts, input.rows, input.reportsByKey, input.now, input.measure),
    input.now,
    input.colors,
    input.measure,
  );
}
