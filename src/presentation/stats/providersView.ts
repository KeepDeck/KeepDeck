import { formatAge, formatMoment, formatPct, windowLabel, windowLevel, windowResetCaption, type AccountUsage, type UsageWindow } from "../../domain/usage";
import type { UsageRow } from "../../domain/usage/history/event";
import { providerWindowGroups, type ProviderWindowGroup, type ProviderWindowRow } from "../../domain/usage/providerWindows";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { windowVerdict } from "../../domain/usage/windowForecast";
import { seriesColorFor } from "../usagePalette";
import { reportedAgeCaption, usageLevelClass } from "../usageView";
import { limitsChartView, type LimitsChartView } from "./limitsChartView";

/**
 * The Limits tab's provider cards, settled. One card per provider — one
 * subscription, one card (user, 2026-11-15) — and in it each live window
 * beside its own chart on its own clock: the 5h window's hours are a
 * sliver of the week's days, so a band on the week's chart showed nothing
 * of it. The most urgent window first, the most urgent provider first.
 * The component renders this and decides nothing.
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
  /** Each live window with a clock to draw, beside its own chart — the 5h
   * window on its hours, the week on its days — the most urgent on top. */
  charted: { window: ProviderWindowView; chart: LimitsChartView }[];
  /** The windows with no chart to draw — reset, or without a span — as
   * small tiles in a row. */
  others: ProviderWindowView[];
}

export type ProvidersView =
  | { kind: "empty"; text: string }
  | {
      kind: "cards";
      title: string;
      cards: ProviderCardView[];
    };

const tone = (text: string, className: string | undefined): ToneText =>
  className ? { text, className } : { text };

function windowView(row: ProviderWindowRow, now: number): ProviderWindowView {
  const { window } = row;
  const verdict = row.expired ? null : windowVerdict(window, row.forecast, now);
  return {
    id: row.id,
    label: windowLabel(window, "long"),
    percent: tone(formatPct(window.usedPct, "used"), usageLevelClass(windowLevel(window, now))),
    expired: row.expired,
    window,
    reset: row.expired
      ? "reset — waiting for its next report"
      : [windowResetCaption(window, now, "long"), window.resetsAt === null ? "" : formatMoment(window.resetsAt, now)].filter(Boolean).join(" · "),
    verdict: verdict === null ? null : tone(verdict.text, usageLevelClass(verdict.level)),
  };
}

const SEVERITY = { critical: 2, warn: 1 } as const;

/** How pressing a window is: the severity of its forecast's warning, how
 * soon it runs out, and how full it is. */
interface Urgency {
  severity: number;
  outAt: number;
  fullest: number;
}

const CALM: Urgency = { severity: 0, outAt: Infinity, fullest: 0 };

function urgency(row: ProviderWindowRow): Urgency {
  if (row.expired) return CALM;
  const { forecast } = row;
  const fullest = row.window.usedPct;
  if (forecast.kind !== "out" || forecast.level === null) return { ...CALM, fullest };
  return { severity: SEVERITY[forecast.level], outAt: forecast.outAt, fullest };
}

/** THE order of pressing things — windows inside a card, and cards by their
 * most pressing window: the severest warning first, then the soonest
 * run-out, then the fullest. */
function moreUrgentFirst(a: Urgency, b: Urgency): number {
  return b.severity - a.severity || a.outAt - b.outAt || b.fullest - a.fullest;
}

function mostUrgent(group: ProviderWindowGroup): Urgency {
  return group.rows.map(urgency).sort(moreUrgentFirst)[0] ?? CALM;
}

export function providersView(
  groups: readonly ProviderWindowGroup[],
  now: number,
  colors: ReadonlyMap<string, string>,
): ProvidersView {
  if (groups.length === 0) {
    return {
      kind: "empty",
      text: "No provider reports yet. Windows appear once a CLI reports its account limits.",
    };
  }
  // Most urgent first; the groups arrive alphabetical and the sort is stable.
  const cards = [...groups]
    .sort((left, right) => moreUrgentFirst(mostUrgent(left), mostUrgent(right)))
    .map((group): ProviderCardView => {
    const stale = usageLevelClass(group.stale ? "warn" : null);
    const views = new Map(group.rows.map((row) => [row, windowView(row, now)]));
    const charted = [...group.rows]
      .sort((left, right) => moreUrgentFirst(urgency(left), urgency(right)))
      .flatMap((row) => {
        const chart = limitsChartView(row, now);
        const window = views.get(row);
        return chart === null || window === undefined ? [] : [{ window, chart }];
      });
    const drawn = new Set(charted.map((entry) => entry.window));
    const windows = [...views.values()];
    return {
      agent: group.agent,
      color: seriesColorFor(colors, group.agent),
      updated: tone(reportedAgeCaption(group.reportedAt, now), stale),
      age: tone(formatAge(group.reportedAt, now), stale),
      windows,
      charted,
      others: windows.filter((window) => !drawn.has(window)),
    };
  });
  return {
    kind: "cards",
    title: "Providers",
    cards,
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
}): ProvidersView {
  return providersView(
    providerWindowGroups(input.accounts, input.rows, input.reportsByKey, input.now),
    input.now,
    input.colors,
  );
}
