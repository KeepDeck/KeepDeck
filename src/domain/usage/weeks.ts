import { formatUtcDay, modelLabel } from "./format";
import {
  providerCostOf,
  tokenTotal,
  type UsageEventV2,
} from "./history/event";
import { addMoney } from "./money";
import { DAY_MS, utcWeekStart, WEEK_MS } from "./time";

/**
 * Completed calendar weeks over the ledger — the Overview block's data.
 * A different lens than the period switcher: fixed UTC weeks (Mon–Sun)
 * comparable to one another, independent of "the last N days from now".
 * Pure and time-injected like every stats query.
 */

export interface UsageWeek {
  /** The week's UTC Monday 00:00. */
  start: number;
  totalTokens: number;
  /** Tokens per agent — the bar's segments; iteration order is
   * insertion order, the VIEW orders by its roster. */
  byAgent: ReadonlyMap<string, number>;
  /** The week's heaviest model by TOKENS — same crown rule as the recap:
   * cost-ranking would crown a costed model over a bigger uncosted one. */
  topModel: { model: string; totalTokens: number } | null;
  providerCostUsd: number;
  costEvents: number;
  /** Whole-percent change vs the previous calendar week; null when that
   * week has no usage to compare against — and always null for the
   * CURRENT week: a week in progress is not comparable to a finished one,
   * and a Monday-morning "-98%" would read as a cliff, not a clock. */
  deltaPct: number | null;
  /** The week containing `now` — still accumulating. */
  current: boolean;
}

interface WeekFold {
  totalTokens: number;
  byAgent: Map<string, number>;
  models: Map<string, { model: string; totalTokens: number }>;
  providerCostUsd: number;
  costEvents: number;
}

/** Every calendar week from the current one back to the oldest event's,
 * newest first and CONTINUOUS — a quiet week renders as a zero row rather
 * than silently vanishing, so "3 weeks ago" is always three rows down.
 * The empty week in progress stays too; the VIEW gives it an honest
 * empty-state line instead of zero-and-dash furniture (field finding). */
export function usageWeeks(
  events: readonly UsageEventV2[],
  now: number,
): UsageWeek[] {
  const folds = new Map<number, WeekFold>();
  let oldest = Infinity;
  for (const event of events) {
    // The future never counts — the same guard every stats query applies.
    if (event.occurredAt > now) continue;
    const start = utcWeekStart(event.occurredAt);
    oldest = Math.min(oldest, start);
    let fold = folds.get(start);
    if (!fold) {
      fold = {
        totalTokens: 0,
        byAgent: new Map(),
        models: new Map(),
        providerCostUsd: 0,
        costEvents: 0,
      };
      folds.set(start, fold);
    }
    const tokens = tokenTotal(event.tokens);
    fold.totalTokens += tokens;
    fold.byAgent.set(event.agent, (fold.byAgent.get(event.agent) ?? 0) + tokens);
    const label = modelLabel(event.model);
    const modelKey = `${event.agent}\0${label}`;
    const model = fold.models.get(modelKey);
    if (model) {
      model.totalTokens += tokens;
    } else {
      fold.models.set(modelKey, { model: label, totalTokens: tokens });
    }
    const cost = providerCostOf(event);
    if (cost !== null) {
      fold.providerCostUsd = addMoney(fold.providerCostUsd, cost);
      fold.costEvents += 1;
    }
  }
  if (folds.size === 0) return [];

  const weeks: UsageWeek[] = [];
  const currentStart = utcWeekStart(now);
  for (let start = currentStart; start >= oldest; start -= WEEK_MS) {
    const fold = folds.get(start);
    const prev = folds.get(start - WEEK_MS);
    const total = fold?.totalTokens ?? 0;
    weeks.push({
      start,
      totalTokens: total,
      byAgent: fold?.byAgent ?? new Map(),
      topModel: topModel(fold),
      providerCostUsd: fold?.providerCostUsd ?? 0,
      costEvents: fold?.costEvents ?? 0,
      deltaPct:
        start !== currentStart && prev !== undefined && prev.totalTokens > 0
          ? Math.round(((total - prev.totalTokens) / prev.totalTokens) * 100)
          : null,
      current: start === currentStart,
    });
  }
  return weeks;
}

function topModel(fold: WeekFold | undefined): UsageWeek["topModel"] {
  if (!fold) return null;
  let top: UsageWeek["topModel"] = null;
  for (const model of fold.models.values()) {
    if (top === null || model.totalTokens > top.totalTokens) top = model;
  }
  return top;
}

/* ---- captions --------------------------------------------------------- */

/** "Jul 27 – Aug 2", the year joining once the week no longer reaches
 * `now`'s ("Sep 8 – Sep 14 · 2025"). The suffix names the END's year: a
 * New-Year week is CURRENT while its Sunday sits in this year, and
 * wearing last year's suffix made the in-progress row read historical.
 * Both ends labeled in UTC like every stats day bucket. */
export function formatWeekLabel(start: number, now: number): string {
  const end = start + 6 * DAY_MS;
  const range = `${formatUtcDay(start)} – ${formatUtcDay(end)}`;
  const year = new Date(end).getUTCFullYear();
  return year === new Date(now).getUTCFullYear() ? range : `${range} · ${year}`;
}

/** "↑ +18%" / "↓ -41%" / a flat "0%" — the row's week-over-week clause,
 * sign convention shared with the recap's delta. Zero wears NO arrow: a
 * week down by half a percent rounds to -0, and `-0 >= 0` once pinned an
 * UP arrow on a decline (review finding). An incomparable week gets an
 * EMPTY cell, not a dash: a placeholder pretending to be a value breaks
 * the column's alignment rhythm. */
export function weekDeltaCaption(deltaPct: number | null): string {
  if (deltaPct === null) return "";
  if (deltaPct === 0) return "0%";
  return deltaPct > 0 ? `↑ +${deltaPct}%` : `↓ -${Math.abs(deltaPct)}%`;
}

/** Is this the still-empty week in progress? Empty means NOTHING landed —
 * tokens or provider cost alike: a cost-only week is real usage and must
 * render as a row, not as this placeholder (review finding). */
export function weekAwaitingUsage(week: UsageWeek): boolean {
  return week.current && week.totalTokens === 0 && week.costEvents === 0;
}

/** The empty in-progress row's line — domain-owned like its delta
 * sibling, so a future digest reuses the exact wording. */
export const WEEK_IN_PROGRESS = "in progress · no usage yet";
