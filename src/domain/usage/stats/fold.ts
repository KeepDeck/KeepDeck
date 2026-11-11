import { nullPrototypeRecord } from "../../json";
import { addMoney } from "../money";
import {
  addCost,
  costOf,
  emptyCostTally,
  tokenTotal,
  usageSessionKey,
  type CostTally,
  type UsageRow,
} from "../history/event";
import { HOUR_MS, localDayNumber, localDayStart, localHourStart, shiftDay } from "../time";
import { inSpan, type Span } from "./period";

/**
 * THE Statistics folds — what every tab of the dialog adds up, in one
 * module, over rows already cut to a span: totals, money over time, and a
 * ranked breakdown by any key. Built on `CostTally`, so money is counted
 * one way everywhere and an unpriced row is never read as free.
 */

export function rowsIn(rows: readonly UsageRow[], span: Span): UsageRow[] {
  return rows.filter((row) => inSpan(row.occurredAt, span));
}

export interface StatsTotals extends CostTally {
  totalTokens: number;
  /** Output, reasoning included — the canonical class. */
  outputTokens: number;
  /** Distinct agent sessions with usage in the rows. */
  sessions: number;
}

export function statsTotals(rows: readonly UsageRow[]): StatsTotals {
  const totals = { ...emptyCostTally(), totalTokens: 0, outputTokens: 0, sessions: 0 };
  const sessions = new Set<string>();
  for (const row of rows) {
    addCost(totals, row);
    totals.totalTokens += tokenTotal(row.tokens);
    totals.outputTokens += row.tokens.output ?? 0;
    sessions.add(usageSessionKey(row));
  }
  totals.sessions = sessions.size;
  return totals;
}

/** Above this share of a span's tokens on models without a known price, its
 * money is not compared: the sum may look confident while most of the
 * usage sits outside it (user decision, 2026-11-11). */
export const COMPARABLE_UNPRICED = 0.1;

/** Whether a span's money can be compared with another's: it has priced
 * usage, and little enough that is unpriced. */
export function comparablyPriced(totals: StatsTotals): boolean {
  if (totals.pricedEvents === 0) return false;
  return totals.totalTokens <= 0 || totals.unpricedTokens / totals.totalTokens <= COMPARABLE_UNPRICED;
}

/** THE money comparison — the headline's and every breakdown row's: the
 * relative change, or null when either side is not comparably priced or
 * the prior side spent nothing. */
export function costChange(current: StatsTotals, prior: StatsTotals | null): number | null {
  if (prior === null || !comparablyPriced(current) || !comparablyPriced(prior)) return null;
  if (!(prior.costUsd > 0)) return null;
  return (current.costUsd - prior.costUsd) / prior.costUsd;
}

/** Add a row's priced cost to its agent's share — the split every bar by
 * agent reads. An unpriced row adds nothing, as in [`addCost`]. Null-
 * prototype records: agent ids are plugin-declared strings, and "__proto__"
 * must stay an agent. */
function addAgentCost(byAgent: Record<string, number>, row: UsageRow): void {
  const cost = costOf(row);
  if (cost !== null) byAgent[row.agent] = addMoney(byAgent[row.agent] ?? 0, cost);
}

/** One step of a money timeline: a local day, or a local hour for today. */
export interface CostStep extends CostTally {
  start: number;
  /** Priced cost per agent; an agent with none in the step has no key. */
  byAgent: Record<string, number>;
}

export type TimelineGranularity = "hour" | "day";

/**
 * Money over the span, continuous and zero-filled — a quiet step is a
 * visible gap, never a skipped one. Days are the reader's calendar days;
 * the hour steps are for a span of one day. An open span starts at its
 * first row's step.
 */
export function costTimeline(
  rows: readonly UsageRow[],
  span: Span,
  granularity: TimelineGranularity,
): CostStep[] {
  const stepOf = granularity === "hour" ? localHourStart : (at: number) => localDayStart(localDayNumber(at));
  const steps = new Map<number, CostStep>();
  let first = Infinity;
  for (const row of rows) {
    if (!inSpan(row.occurredAt, span)) continue;
    const start = stepOf(row.occurredAt);
    first = Math.min(first, start);
    let step = steps.get(start);
    if (!step) {
      step = { start, byAgent: nullPrototypeRecord<number>(), ...emptyCostTally() };
      steps.set(start, step);
    }
    addCost(step, row);
    addAgentCost(step.byAgent, row);
  }
  const from = Number.isFinite(span.from) ? stepOf(span.from) : first;
  if (!Number.isFinite(from)) return [];
  const last = stepOf(span.to - 1);
  const out: CostStep[] = [];
  for (let start = from; start <= last; start = nextStep(start, granularity)) {
    out.push(steps.get(start) ?? { start, byAgent: nullPrototypeRecord<number>(), ...emptyCostTally() });
  }
  return out;
}

function nextStep(start: number, granularity: TimelineGranularity): number {
  if (granularity === "day") return localDayStart(shiftDay(localDayNumber(start), 1));
  // Hours step through instants, so a repeated clock hour is two steps and a
  // skipped one none; the guard keeps a half-hour shift from standing still.
  const next = localHourStart(start + HOUR_MS);
  return next > start ? next : start + HOUR_MS;
}

/** One group of a breakdown. */
export interface BreakdownRow extends StatsTotals {
  key: string;
  /** The group's newest row — where names and places are read from. */
  latest: UsageRow;
  /** The group's share of the span's priced cost, 0–1. */
  share: number;
  /** Priced cost per agent, for a bar split by agent. */
  byAgent: Readonly<Record<string, number>>;
  /** Against the same group in the prior rows, by [`costChange`]. */
  change: number | null;
  /** How many groups this row folds together — 0 for a group of its own,
   * N for the "N more" row that closes a long list. */
  folded: number;
}

/**
 * Rows grouped by `keyOf`, ranked by priced cost (tokens break ties), each
 * set against the same key in `prior`. Past `top` groups the rest fold into
 * one closing row — folded from its RAW rows, so a session spread over
 * several folded groups counts once. A list one longer than `top` is shown
 * whole: a "1 more" row would hide exactly as much as it shows.
 */
export function breakdown(
  current: readonly UsageRow[],
  prior: readonly UsageRow[],
  keyOf: (row: UsageRow) => string,
  top: number,
): BreakdownRow[] {
  const groups = groupBy(current, keyOf);
  const priorGroups = groupBy(prior, keyOf);
  const spanCost = statsTotals(current).costUsd;
  // Every group, the folded one included, holds at least one row.
  const rowOf = (key: string, rows: UsageRow[], priorRows: UsageRow[], folded: number): BreakdownRow => {
    const totals = statsTotals(rows);
    const byAgent = nullPrototypeRecord<number>();
    for (const row of rows) addAgentCost(byAgent, row);
    return {
      ...totals,
      key,
      latest: rows.reduce((newest, row) => (row.occurredAt > newest.occurredAt ? row : newest)),
      share: spanCost > 0 ? totals.costUsd / spanCost : 0,
      byAgent,
      change: costChange(totals, statsTotals(priorRows)),
      folded,
    };
  };
  const ranked = [...groups]
    .map(([key, rows]) => rowOf(key, rows, priorGroups.get(key) ?? [], 0))
    .sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens);
  if (ranked.length <= top + 1) return ranked;
  const tail = ranked.slice(top);
  const tailRows = tail.flatMap((row) => groups.get(row.key) ?? []);
  const tailPrior = tail.flatMap((row) => priorGroups.get(row.key) ?? []);
  return [...ranked.slice(0, top), rowOf(OTHER_KEY, tailRows, tailPrior, tail.length)];
}

/** The key of the row that folds a breakdown's tail. */
export const OTHER_KEY = "\0other";

function groupBy(rows: readonly UsageRow[], keyOf: (row: UsageRow) => string): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
