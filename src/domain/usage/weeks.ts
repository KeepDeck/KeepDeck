import { modelLabel } from "./format";
import {
  addCost,
  emptyCostTally,
  tokenTotal,
  type CostTally,
  type UsageRow,
} from "./history/event";
import { DAY_MS, utcWeekStart, WEEK_MS } from "./time";

/**
 * Completed calendar weeks over the ledger — the Overview block's data.
 * A different lens than the period switcher: fixed UTC weeks (Mon–Sun)
 * comparable to one another, independent of "the last N days from now".
 * Pure and time-injected like every stats query.
 */

/** Derived, not typed out: the week length a week's days count against is
 * the same one `WEEK_MS` already states. */
export const DAYS_PER_WEEK = WEEK_MS / DAY_MS;

export interface UsageWeek extends CostTally {
  /** The week's UTC Monday 00:00. */
  start: number;
  totalTokens: number;
  /** The bar's segments: agents that burned tokens this week, in the
   * roster's own alphabetical order (daily.ts's fixed-entity rule) — the
   * view adds color, never re-derives membership or order. */
  segments: readonly { agent: string; totalTokens: number }[];
  /** The week's heaviest model by TOKENS — same crown rule as the recap:
   * cost-ranking would crown a costed model over a bigger uncosted one. */
  topModel: { model: string; totalTokens: number } | null;
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
  cost: CostTally;
}

/** Every calendar week from the current one back to the oldest event's,
 * newest first and CONTINUOUS — a quiet week renders as a zero row rather
 * than silently vanishing, so "3 weeks ago" is always three rows down.
 * The empty week in progress stays too; the VIEW gives it an honest
 * empty-state line instead of zero-and-dash furniture (field finding). */
export function usageWeeks(
  events: readonly UsageRow[],
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
        cost: emptyCostTally(),
      };
      folds.set(start, fold);
    }
    const tokens = tokenTotal(event.tokens);
    fold.totalTokens += tokens;
    fold.byAgent.set(event.agent, (fold.byAgent.get(event.agent) ?? 0) + tokens);
    const modelKey = `${event.agent}\0${modelLabel(event.model)}`;
    const model = fold.models.get(modelKey);
    if (model) {
      model.totalTokens += tokens;
    } else {
      fold.models.set(modelKey, { model: modelLabel(event.model, event.modelName), totalTokens: tokens });
    }
    addCost(fold.cost, event);
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
      segments: segments(fold),
      topModel: topModel(fold),
      ...(fold?.cost ?? emptyCostTally()),
      deltaPct:
        start !== currentStart && prev !== undefined && prev.totalTokens > 0
          ? Math.round(((total - prev.totalTokens) / prev.totalTokens) * 100)
          : null,
      current: start === currentStart,
    });
  }
  return weeks;
}

function segments(fold: WeekFold | undefined): UsageWeek["segments"] {
  if (!fold) return [];
  return [...fold.byAgent]
    .filter(([, tokens]) => tokens > 0)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([agent, totalTokens]) => ({ agent, totalTokens }));
}

function topModel(fold: WeekFold | undefined): UsageWeek["topModel"] {
  if (!fold) return null;
  let top: UsageWeek["topModel"] = null;
  for (const model of fold.models.values()) {
    if (top === null || model.totalTokens > top.totalTokens) top = model;
  }
  return top;
}

/** How many of the week's seven days have STARTED, 1–7 — the honest measure
 * of how much of an in-progress week is in hand. Days, not hours: the row's
 * numbers are day-bucketed like every other stats total, so a fraction of a
 * day would claim a precision the data does not carry. */
export function weekDaysElapsed(start: number, now: number): number {
  const days = Math.floor((now - start) / DAY_MS) + 1;
  return Math.min(DAYS_PER_WEEK, Math.max(1, days));
}

/** Is this the still-empty week in progress? Empty means NOTHING landed —
 * tokens or a priced event alike: a week with usage renders as a row, not
 * as this placeholder (review finding). */
export function weekAwaitingUsage(week: UsageWeek): boolean {
  return week.current && week.totalTokens === 0 && week.pricedEvents === 0;
}
