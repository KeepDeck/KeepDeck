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
  providerId?: string;
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
  for (const key of ["providerId", "model", "pricingVersion"]) {
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
