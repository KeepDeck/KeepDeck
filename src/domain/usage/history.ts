import type { PaneUsage, TokenCounts } from "@keepdeck/plugin-api";

/** Durable analytics horizon. Older events are invisible to queries and are
 * compacted down to at most one baseline checkpoint per session. */
export const USAGE_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;

export type UsageCostSource = "reported" | "estimated" | "unavailable";

/** The cumulative counters stored beside every delta. They are not summed by
 * queries; they make a resumed/replayed session idempotent after app restart. */
export interface UsageObservation {
  tokens: TokenCounts;
  costUsd?: number;
}

/** One canonical usage delta. Provider payloads remain plugin-owned; this is
 * the stable host record consumed by Settings → Stats. */
export interface UsageEventV1 {
  schemaVersion: typeof USAGE_EVENT_SCHEMA_VERSION;
  eventId: string;
  occurredAt: number;
  capturedAt: number;
  agent: string;
  model?: string;
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
  paneId: string;
  paneName: string;
  sessionId: string;
  rootSessionId: string;
  worktree?: {
    path: string;
    branch?: string;
    repo: string;
  };
  tokens: TokenCounts;
  costUsd?: number;
  costSource: UsageCostSource;
  pricingVersion?: string;
  observation: UsageObservation;
}

export interface UsageDelta {
  tokens: TokenCounts;
  reportedCostUsd?: number;
  hasReportedCost: boolean;
  observation: UsageObservation;
}

const TOKEN_KEYS: readonly (keyof TokenCounts)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
];

/** Convert a cumulative pane snapshot into a non-negative delta. A counter
 * dropping inside the same session is treated as a source reset, never as
 * negative usage. Missing fields stay unknown and preserve their baseline. */
export function usageDelta(
  current: Pick<PaneUsage, "totalTokens" | "costUsd">,
  previous?: UsageObservation,
): UsageDelta {
  const observationTokens: TokenCounts = { ...(previous?.tokens ?? {}) };
  const deltaTokens: TokenCounts = {};
  for (const key of TOKEN_KEYS) {
    const value = current.totalTokens?.[key];
    if (!finiteNonNegative(value)) continue;
    const before = previous?.tokens[key];
    const delta = finiteNonNegative(before) && value >= before ? value - before : value;
    observationTokens[key] = value;
    if (delta > 0) deltaTokens[key] = delta;
  }

  let reportedCostUsd: number | undefined;
  let observedCost = previous?.costUsd;
  if (finiteNonNegative(current.costUsd)) {
    const rawDelta =
      finiteNonNegative(previous?.costUsd) && current.costUsd >= previous.costUsd
        ? current.costUsd - previous.costUsd
        : current.costUsd;
    // Provider totals are decimal currency but arrive as binary floats. Keep
    // subtraction noise (1.4 - 1) out of the durable ledger.
    reportedCostUsd = Math.round(rawDelta * 1_000_000_000_000) / 1_000_000_000_000;
    observedCost = current.costUsd;
  }

  return {
    tokens: deltaTokens,
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    hasReportedCost: reportedCostUsd !== undefined,
    observation: {
      tokens: observationTokens,
      ...(observedCost !== undefined ? { costUsd: observedCost } : {}),
    },
  };
}

export function usageDeltaEmpty(delta: UsageDelta): boolean {
  return (
    Object.keys(delta.tokens).length === 0 &&
    (delta.reportedCostUsd === undefined || delta.reportedCostUsd === 0)
  );
}

export function encodeUsageEvent(event: UsageEventV1): string {
  return JSON.stringify(event);
}

/** Tolerant per-line decoder: malformed/torn/future records are skipped, so
 * one bad append never destroys the rest of the history. */
export function decodeUsageEvent(line: string): UsageEventV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record(value) || value.schemaVersion !== USAGE_EVENT_SCHEMA_VERSION) {
    return null;
  }
  for (const key of [
    "eventId",
    "agent",
    "workspaceId",
    "workspaceName",
    "workspaceCwd",
    "paneId",
    "paneName",
    "sessionId",
    "rootSessionId",
  ]) {
    if (typeof value[key] !== "string" || value[key] === "") return null;
  }
  if (!finiteNonNegative(value.occurredAt) || !finiteNonNegative(value.capturedAt)) {
    return null;
  }
  if (!record(value.tokens) || !record(value.observation)) return null;
  const tokens = readTokens(value.tokens);
  const observedTokens = record(value.observation.tokens)
    ? readTokens(value.observation.tokens)
    : null;
  if (!tokens || !observedTokens) return null;
  const costSource = value.costSource;
  if (
    costSource !== "reported" &&
    costSource !== "estimated" &&
    costSource !== "unavailable"
  ) {
    return null;
  }
  if (value.costUsd !== undefined && !finiteNonNegative(value.costUsd)) return null;
  const observationCost = value.observation.costUsd;
  if (observationCost !== undefined && !finiteNonNegative(observationCost)) {
    return null;
  }
  if (value.worktree !== undefined) {
    if (
      !record(value.worktree) ||
      typeof value.worktree.path !== "string" ||
      typeof value.worktree.repo !== "string"
    ) {
      return null;
    }
    if (
      value.worktree.branch !== undefined &&
      typeof value.worktree.branch !== "string"
    ) {
      return null;
    }
  }
  for (const key of ["model", "pricingVersion"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
  }
  return value as unknown as UsageEventV1;
}

export function usageSessionKey(
  value: Pick<UsageEventV1, "agent" | "sessionId">,
): string {
  return `${value.agent}\0${value.sessionId}`;
}

export function tokenTotal(tokens: TokenCounts): number {
  if (finiteNonNegative(tokens.total)) return tokens.total;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheWrite ?? 0) +
    (tokens.reasoning ?? 0)
  );
}

export type UsageStatsPeriodDays = 1 | 7 | 30 | 90;

export interface UsageStatsTotals {
  tokens: TokenCounts;
  totalTokens: number;
  costUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  pricedEvents: number;
  unpricedEvents: number;
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
  periodDays: UsageStatsPeriodDays;
  eventCount: number;
  sessionCount: number;
  totals: UsageStatsTotals;
  byModel: UsageStatsRow[];
  sessions: UsageStatsRow[];
}

/** Aggregate immutable deltas for the Stats screen. `now` is injected so
 * period boundaries and tests stay deterministic. */
export function queryUsageStats(
  events: readonly UsageEventV1[],
  periodDays: UsageStatsPeriodDays,
  now = Date.now(),
): UsageStats {
  const cutoff = now - periodDays * 24 * 60 * 60 * 1_000;
  const selected = events.filter(
    (event) => event.occurredAt >= cutoff && event.occurredAt <= now,
  );
  const modelRows = new Map<string, UsageStatsRow>();
  const sessionRows = new Map<string, UsageStatsRow>();
  const totals = emptyTotals();

  for (const event of selected) {
    addEvent(totals, event);
    const modelKey = [event.agent, event.model ?? "unknown"].join("\0");
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
        right.costUsd - left.costUsd ||
        right.totalTokens - left.totalTokens ||
        right.lastOccurredAt - left.lastOccurredAt,
    );
  return {
    periodDays,
    eventCount: selected.length,
    sessionCount: sessionRows.size,
    totals,
    byModel: ranked(modelRows),
    sessions: ranked(sessionRows),
  };
}

function emptyTotals(): UsageStatsTotals {
  return {
    tokens: {},
    totalTokens: 0,
    costUsd: 0,
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    pricedEvents: 0,
    unpricedEvents: 0,
  };
}

function rowFor(
  rows: Map<string, UsageStatsRow>,
  key: string,
  event: UsageEventV1,
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
  event: UsageEventV1,
) {
  for (const key of TOKEN_KEYS) {
    const value = event.tokens[key];
    if (value !== undefined) target.tokens[key] = (target.tokens[key] ?? 0) + value;
  }
  target.totalTokens += tokenTotal(event.tokens);
  if (event.costSource === "reported") {
    target.reportedCostUsd = addMoney(target.reportedCostUsd, event.costUsd ?? 0);
    target.costUsd = addMoney(target.costUsd, event.costUsd ?? 0);
    target.pricedEvents += 1;
  } else if (event.costSource === "estimated") {
    target.estimatedCostUsd = addMoney(target.estimatedCostUsd, event.costUsd ?? 0);
    target.costUsd = addMoney(target.costUsd, event.costUsd ?? 0);
    target.pricedEvents += 1;
  } else {
    target.unpricedEvents += 1;
  }
  if ("lastOccurredAt" in target) {
    target.lastOccurredAt = Math.max(target.lastOccurredAt ?? 0, event.occurredAt);
  }
}

function addMoney(left: number, right: number): number {
  return Math.round((left + right) * 1_000_000_000_000) / 1_000_000_000_000;
}

function readTokens(value: Record<string, unknown>): TokenCounts | null {
  const result: TokenCounts = {};
  for (const key of TOKEN_KEYS) {
    const item = value[key];
    if (item === undefined) continue;
    if (!finiteNonNegative(item)) return null;
    result[key] = item;
  }
  return result;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
