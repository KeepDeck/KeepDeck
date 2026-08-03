import type { TokenCounts } from "@keepdeck/plugin-api";
import { modelLabel } from "../format";
import { addMoney } from "../money";
import { DAY_MS } from "../time";
import {
  providerCostOf,
  TOKEN_KEYS,
  tokenTotal,
  usageSessionKey,
  type UsageEventV2,
} from "./event";

/**
 * Period aggregation over the ledger for the Stats screen: totals, per-model
 * and per-session rows. Pure and time-injected like every stats query.
 */

export type UsageStatsPeriodDays = 1 | 7 | 30 | 90;

/** A Stats aggregation window: a rolling day count ending at `now`, or the
 * entire ledger — history is never pruned, so "all" is genuinely all-time. */
export type UsageStatsPeriod = UsageStatsPeriodDays | "all";

export interface UsageStatsTotals {
  tokens: TokenCounts;
  totalTokens: number;
  providerCostUsd: number;
  costEvents: number;
}

export interface UsageStatsRow extends UsageStatsTotals {
  key: string;
  agent: string;
  model?: string;
  workspaceName?: string;
  paneName?: string;
  sessionId?: string;
  lastOccurredAt: number;
}

export interface UsageStats {
  period: UsageStatsPeriod;
  eventCount: number;
  sessionCount: number;
  /** Sessions with at least one provider-reported cost event — the cost
   * coverage the disclaimer under the cards is phrased from. */
  costSessionCount: number;
  totals: UsageStatsTotals;
  byModel: UsageStatsRow[];
  sessions: UsageStatsRow[];
}

/** The inclusive lower bound of a period ending at `now`. */
export function periodCutoff(period: UsageStatsPeriod, now: number): number {
  return period === "all" ? -Infinity : now - period * DAY_MS;
}

/** The newest instant the ledger claims — what a live surface feeds the
 * wall clock's `atLeast`, so a just-appended event clears the queries'
 * `occurredAt <= now` upper bound immediately instead of hiding until the
 * next slow tick. */
export function latestOccurredAt(events: readonly UsageEventV2[]): number {
  let latest = 0;
  for (const event of events) latest = Math.max(latest, event.occurredAt);
  return latest;
}

/** Aggregate immutable deltas for the Stats screen. `now` is injected so
 * period boundaries and tests stay deterministic. */
export function queryUsageStats(
  events: readonly UsageEventV2[],
  period: UsageStatsPeriod,
  now = Date.now(),
): UsageStats {
  const cutoff = periodCutoff(period, now);
  const selected = events.filter(
    (event) => event.occurredAt >= cutoff && event.occurredAt <= now,
  );
  const modelRows = new Map<string, UsageStatsRow>();
  const sessionRows = new Map<string, UsageStatsRow>();
  const totals = emptyTotals();

  for (const event of selected) {
    addEvent(totals, event);
    const modelKey = [event.agent, modelLabel(event.model)].join("\0");
    const model = rowFor(modelRows, modelKey, event);
    addEvent(model, event);

    const sessionKey = usageSessionKey(event);
    const session = rowFor(sessionRows, sessionKey, event);
    if (event.occurredAt >= session.lastOccurredAt) {
      session.workspaceName = event.workspaceName;
      session.paneName = event.paneName;
      session.model = event.model;
    }
    addEvent(session, event);
  }

  const ranked = (rows: Map<string, UsageStatsRow>) =>
    [...rows.values()].sort(
      (left, right) =>
        right.providerCostUsd - left.providerCostUsd ||
        right.totalTokens - left.totalTokens ||
        right.lastOccurredAt - left.lastOccurredAt,
    );
  return {
    period,
    eventCount: selected.length,
    sessionCount: sessionRows.size,
    costSessionCount: [...sessionRows.values()].filter(
      (row) => row.costEvents > 0,
    ).length,
    totals,
    byModel: ranked(modelRows),
    sessions: ranked(sessionRows),
  };
}

function emptyTotals(): UsageStatsTotals {
  return {
    tokens: {},
    totalTokens: 0,
    providerCostUsd: 0,
    costEvents: 0,
  };
}

function rowFor(
  rows: Map<string, UsageStatsRow>,
  key: string,
  event: UsageEventV2,
): UsageStatsRow {
  let row = rows.get(key);
  if (!row) {
    row = {
      key,
      agent: event.agent,
      ...(event.model ? { model: event.model } : {}),
      ...(event.workspaceName ? { workspaceName: event.workspaceName } : {}),
      ...(event.paneName ? { paneName: event.paneName } : {}),
      sessionId: event.sessionId,
      lastOccurredAt: event.occurredAt,
      ...emptyTotals(),
    };
    rows.set(key, row);
  }
  return row;
}

function addEvent(
  target: UsageStatsTotals & { lastOccurredAt?: number },
  event: UsageEventV2,
) {
  for (const key of TOKEN_KEYS) {
    const value = event.tokens[key];
    if (value !== undefined) target.tokens[key] = (target.tokens[key] ?? 0) + value;
  }
  target.totalTokens += tokenTotal(event.tokens);
  const cost = providerCostOf(event);
  if (cost !== null) {
    target.providerCostUsd = addMoney(target.providerCostUsd, cost);
    target.costEvents += 1;
  }
  if ("lastOccurredAt" in target) {
    target.lastOccurredAt = Math.max(target.lastOccurredAt ?? 0, event.occurredAt);
  }
}
