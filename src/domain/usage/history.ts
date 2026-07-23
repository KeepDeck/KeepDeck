import type { PaneUsage, TokenCounts } from "@keepdeck/plugin-api";

/** Durable analytics horizon. Older events are invisible to queries and are
 * compacted down to at most one baseline checkpoint per session. */
export const USAGE_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const USAGE_EVENT_SCHEMA_VERSION = 2 as const;

export type UsageCostSource = "provider" | "unavailable";

/** The cumulative counters stored beside every delta. They are not summed by
 * queries; they make a resumed/replayed session idempotent after app restart. */
export interface UsageObservation {
  tokens: TokenCounts;
  costUsd?: number;
}

/** One canonical usage delta. Provider payloads remain plugin-owned; this is
 * the stable host record consumed by the global Usage statistics screen. */
interface UsageEventV2Base {
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
  observation: UsageObservation;
}

export type UsageEventV2 = UsageEventV2Base &
  (
    | { costSource: "provider"; costUsd: number }
    | { costSource: "unavailable"; costUsd?: never }
  );

interface UsageDeltaBase {
  tokens: TokenCounts;
  observation: UsageObservation;
}

export type UsageDelta = UsageDeltaBase &
  (
    | { cost: { source: "provider"; usd: number } }
    | { cost: { source: "unavailable" } }
  );

export interface UsageDeltaOptions {
  /** Seed each previously unseen cumulative dimension of a resumed session
   * without attributing its lifetime counters/cost to the current period.
   * Token totals and provider cost may arrive in separate reports. */
  baselineOnly?: boolean;
}

const TOKEN_KEYS: readonly (keyof TokenCounts)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
];

/** Convert a cumulative pane snapshot into a non-negative durable delta.
 * A dropped counter/cost is a source reset, never negative usage. */
export function usageDelta(
  current: Pick<PaneUsage, "totalTokens" | "costUsd">,
  previous?: UsageObservation,
  options: UsageDeltaOptions = {},
): UsageDelta {
  const seedResumed = options.baselineOnly === true;
  const observationTokens: TokenCounts = { ...(previous?.tokens ?? {}) };
  const deltaTokens: TokenCounts = {};

  let providerCostUsd: number | undefined;
  let observedCost = previous?.costUsd;
  if (finiteNonNegative(current.costUsd)) {
    const previousCost = previous?.costUsd;
    const hasPreviousCost = finiteNonNegative(previousCost);
    const seedCost = seedResumed && !hasPreviousCost;
    if (!seedCost) {
      const rawDelta =
        hasPreviousCost && current.costUsd >= previousCost
          ? current.costUsd - previousCost
          : current.costUsd;
      // Provider totals are decimal currency but arrive as binary floats.
      if (!hasPreviousCost || rawDelta > 0) {
        providerCostUsd =
          Math.round(rawDelta * 1_000_000_000_000) / 1_000_000_000_000;
      }
    }
    observedCost = current.costUsd;
  }

  for (const key of TOKEN_KEYS) {
    const value = current.totalTokens?.[key];
    if (!finiteNonNegative(value)) continue;
    const before = previous?.tokens[key];
    const seedToken = seedResumed && !finiteNonNegative(before);
    const delta =
      finiteNonNegative(before) && value >= before ? value - before : value;
    observationTokens[key] = value;
    if (!seedToken && delta > 0) deltaTokens[key] = delta;
  }

  const base: UsageDeltaBase = {
    tokens: deltaTokens,
    observation: {
      tokens: observationTokens,
      ...(observedCost !== undefined ? { costUsd: observedCost } : {}),
    },
  };
  return providerCostUsd !== undefined
    ? { ...base, cost: { source: "provider", usd: providerCostUsd } }
    : { ...base, cost: { source: "unavailable" } };
}

export function usageDeltaEmpty(delta: UsageDelta): boolean {
  return (
    Object.keys(delta.tokens).length === 0 &&
    delta.cost.source === "unavailable"
  );
}

export function encodeUsageEvent(event: UsageEventV2): string {
  return JSON.stringify(event);
}

export interface DecodedUsageEvent {
  event: UsageEventV2;
  migrated: boolean;
}

/** Tolerant per-line decoder with a narrow v1 salvage path. V1 Codex and
 * OpenCode token deltas remain trustworthy, but locally estimated costs are
 * discarded. Claude v1 token counters came from a non-cumulative status-line
 * field, so only its positive provider-reported cost deltas survive. */
export function decodeUsageEventLine(line: string): DecodedUsageEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record(value)) {
    return null;
  }
  const migrated = value.schemaVersion === 1;
  if (!migrated && value.schemaVersion !== USAGE_EVENT_SCHEMA_VERSION) return null;
  if (
    migrated &&
    value.costSource !== "reported" &&
    value.costSource !== "estimated" &&
    value.costSource !== "unavailable"
  ) {
    return null;
  }

  const common = readCommonEvent(value);
  if (!common) return null;
  const tokens = readTokens(value.tokens as Record<string, unknown>);
  const observation = value.observation as Record<string, unknown>;
  const observedTokens = readTokens(observation.tokens as Record<string, unknown>);
  if (!tokens || !observedTokens) return null;
  const observationCost = observation.costUsd;
  if (observationCost !== undefined && !finiteNonNegative(observationCost)) {
    return null;
  }

  const observed: UsageObservation = {
    tokens: migrated && value.agent === "claude" ? {} : observedTokens,
    ...(observationCost !== undefined ? { costUsd: observationCost } : {}),
  };
  if (migrated) {
    const providerCost =
      value.costSource === "reported" && finiteNonNegative(value.costUsd)
        ? value.costUsd
        : undefined;
    if (value.agent === "claude") {
      if (providerCost === undefined || providerCost <= 0) return null;
      return {
        migrated: true,
        event: {
          ...common,
          schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
          tokens: {},
          costSource: "provider",
          costUsd: providerCost,
          observation: observed,
        },
      };
    }
    return {
      migrated: true,
      event:
        providerCost !== undefined
          ? {
              ...common,
              schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
              tokens,
              costSource: "provider",
              costUsd: providerCost,
              observation: observed,
            }
          : {
              ...common,
              schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
              tokens,
              costSource: "unavailable",
              observation: observed,
            },
    };
  }

  if (value.costSource === "provider") {
    if (!finiteNonNegative(value.costUsd)) return null;
    return {
      migrated: false,
      event: {
        ...common,
        schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
        tokens,
        costSource: "provider",
        costUsd: value.costUsd,
        observation: observed,
      },
    };
  }
  if (value.costSource !== "unavailable" || value.costUsd !== undefined) {
    return null;
  }
  return {
    migrated: false,
    event: {
      ...common,
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      tokens,
      costSource: "unavailable",
      observation: observed,
    },
  };
}

/** Decode an event when callers do not need migration provenance. */
export function decodeUsageEvent(line: string): UsageEventV2 | null {
  return decodeUsageEventLine(line)?.event ?? null;
}

function readCommonEvent(
  value: Record<string, unknown>,
): Omit<
  UsageEventV2Base,
  "schemaVersion" | "tokens" | "observation"
> | null {
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
  if (!record(value.observation.tokens)) return null;
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
  for (const key of ["model"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
  }
  return {
    eventId: value.eventId as string,
    occurredAt: value.occurredAt,
    capturedAt: value.capturedAt,
    agent: value.agent as string,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    workspaceId: value.workspaceId as string,
    workspaceName: value.workspaceName as string,
    workspaceCwd: value.workspaceCwd as string,
    paneId: value.paneId as string,
    paneName: value.paneName as string,
    sessionId: value.sessionId as string,
    rootSessionId: value.rootSessionId as string,
    ...(value.worktree !== undefined
      ? { worktree: value.worktree as UsageEventV2Base["worktree"] }
      : {}),
  };
}

export function usageSessionKey(
  value: Pick<UsageEventV2, "agent" | "sessionId">,
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
  events: readonly UsageEventV2[],
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
        right.providerCostUsd - left.providerCostUsd ||
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
  if (event.costSource === "provider") {
    target.providerCostUsd = addMoney(target.providerCostUsd, event.costUsd);
    target.costEvents += 1;
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
