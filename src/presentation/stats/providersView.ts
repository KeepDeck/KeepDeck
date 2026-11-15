import { formatAge, formatMoment, formatPct, windowLabel, windowLevel, windowResetCaption, type AccountUsage, type UsageWindow } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { providerWindowGroups, type ProviderWindowGroup, type ProviderWindowRow } from "../../domain/usage/providerWindows";
import type { StatsMeasure } from "../../domain/usage/stats/measure";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowVerdict } from "../../domain/usage/windowForecast";
import { readingAt } from "../../domain/usage/windowHistory";
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
  /** Where the last window stood at this point of its own, while the
   * journal reaches back that far. */
  earlier: string | null;
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
   * span — or null when none is. */
  main: string | null;
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

function windowView(row: ProviderWindowRow, now: number): ProviderWindowView {
  const { window, span } = row;
  const verdict = row.expired ? null : windowVerdict(window, row.forecast, now);
  const elapsed = span === null ? null : Math.min(1, Math.max(0, (now - span.from) / (span.to - span.from)));
  const last = row.earlier[row.earlier.length - 1];
  const before = span === null || last === undefined ? null : readingAt(last, now - span.from);
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
    earlier: before === null ? null : `last window at this point: ${formatPct(before, "used")}`,
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

/** How pressing a provider is: a forecast that warns first, then the
 * fullest live window. */
function risk(group: ProviderWindowGroup): number {
  return Math.max(
    0,
    ...group.rows
      .filter((row) => !row.expired)
      .map((row) => (row.forecast.kind === "out" && row.forecast.level !== null ? 1000 : 0) + row.window.usedPct),
  );
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
  const cards = [...groups].sort((left, right) => risk(right) - risk(left)).map((group): ProviderCardView => {
    const main = mainRow(group.rows);
    const stale = usageLevelClass(group.stale ? "warn" : null);
    return {
      agent: group.agent,
      color: seriesColorFor(colors, group.agent),
      updated: tone(reportedAgeCaption(group.reportedAt, now), stale),
      age: tone(formatAge(group.reportedAt, now), stale),
      windows: group.rows.map((row) => windowView(row, now)),
      main: main?.id ?? null,
      chart: main === null ? null : limitsChartView(main, group.rows.filter((row) => row !== main), now, measure),
    };
  });
  return {
    kind: "cards",
    title: "Providers",
    cards,
    note: cards.some((card) => card.chart !== null && card.chart.bars.length > 0) ? BAR_NOTES[measure] : null,
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
