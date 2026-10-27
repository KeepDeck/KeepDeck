import { isJsonRecord, type TokenCounts } from "@keepdeck/plugin-api";
import { finiteNonNegative } from "./guards";
import { isV1CostSource, salvageV1Event } from "./migrateV1";

/**
 * The durable usage event — its schema and its wire codec. Provider payloads
 * remain plugin-owned; this is the stable host record the append-only JSONL
 * ledger stores and every stats consumer reads. Deltas are produced by
 * `./delta`, aggregation lives in `./query`.
 */

export const USAGE_EVENT_SCHEMA_VERSION = 2 as const;

export type UsageCostSource = "provider" | "unavailable";

/** The cumulative counters stored beside every delta. They are not summed by
 * queries; they make a resumed/replayed session idempotent after app restart. */
export interface UsageObservation {
  tokens: TokenCounts;
  costUsd?: number;
}

/** One canonical usage delta. */
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

export const TOKEN_KEYS: readonly (keyof TokenCounts)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
];

export function encodeUsageEvent(event: UsageEventV2): string {
  return JSON.stringify(event);
}

export interface DecodedUsageEvent {
  event: UsageEventV2;
  migrated: boolean;
}

/** THE home of the occurredAt sanity rule: an observation instant must be
 * positive and can never postdate its capture. Zero is a real sentinel — a
 * catch-up replay of a session file with no usable timestamp normalizes at
 * epoch — and with retention gone an epoch event would poison every
 * all-time consumer (a 20k-bucket "All" chart, a 496,000-hour session).
 * Both the writer and the decoder clamp through here, so old ledgers heal
 * on load and new ones never carry the damage. */
export function clampOccurredAt(occurredAt: number, capturedAt: number): number {
  if (!(occurredAt > 0) || occurredAt > capturedAt) return capturedAt;
  return occurredAt;
}

/** Tolerant per-line decoder, with a narrow salvage path for schema-1 lines
 * ([`salvageV1Event`]). */
export function decodeUsageEventLine(line: string): DecodedUsageEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonRecord(value)) {
    return null;
  }
  const migrated = value.schemaVersion === 1;
  if (!migrated && value.schemaVersion !== USAGE_EVENT_SCHEMA_VERSION) return null;
  if (migrated && !isV1CostSource(value.costSource)) return null;

  const common = readCommonEvent(value);
  if (!common) return null;
  // A clamped instant marks the line for compaction just like a schema
  // migration: the file heals instead of re-poisoning every load.
  const occurredAt = clampOccurredAt(common.occurredAt, common.capturedAt);
  const sanitized = occurredAt !== common.occurredAt;
  common.occurredAt = occurredAt;
  // Their shape is readCommonEvent's to check; asked again here so the
  // reads below stand on the values themselves.
  const observation = value.observation;
  if (!isJsonRecord(value.tokens) || !isJsonRecord(observation) || !isJsonRecord(observation.tokens)) return null;
  const tokens = readTokens(value.tokens);
  const observedTokens = readTokens(observation.tokens);
  if (!tokens || !observedTokens) return null;
  const observationCost = observation.costUsd;
  if (observationCost !== undefined && !finiteNonNegative(observationCost)) {
    return null;
  }

  if (migrated) {
    const event = salvageV1Event(
      { common, tokens, observedTokens, observationCost, costSource: value.costSource, costUsd: value.costUsd },
      USAGE_EVENT_SCHEMA_VERSION,
    );
    return event ? { migrated: true, event } : null;
  }
  const observed: UsageObservation = {
    tokens: observedTokens,
    ...(observationCost !== undefined ? { costUsd: observationCost } : {}),
  };

  if (value.costSource === "provider") {
    if (!finiteNonNegative(value.costUsd)) return null;
    return {
      migrated: sanitized,
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
    migrated: sanitized,
    event: {
      ...common,
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      tokens,
      costSource: "unavailable",
      observation: observed,
    },
  };
}

/** True for a line written by a NEWER schema than this build understands.
 * The decoder rejects such a line, but compaction must not DELETE it: an
 * app downgrade would otherwise erase the newer build's events from the
 * all-time ledger. Preserved verbatim, re-decoded by the build that wrote
 * it. */
export function isFutureSchemaLine(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return (
      isJsonRecord(value) &&
      typeof value.schemaVersion === "number" &&
      value.schemaVersion > USAGE_EVENT_SCHEMA_VERSION
    );
  } catch {
    return false;
  }
}

/** What every event says whatever its schema: who, where and when. */
export type UsageEventCommon = Omit<UsageEventV2Base, "schemaVersion" | "tokens" | "observation">;

function readCommonEvent(value: Record<string, unknown>): UsageEventCommon | null {
  const eventId = nonEmptyString(value.eventId);
  const agent = nonEmptyString(value.agent);
  const workspaceId = nonEmptyString(value.workspaceId);
  const workspaceName = nonEmptyString(value.workspaceName);
  const workspaceCwd = nonEmptyString(value.workspaceCwd);
  const paneId = nonEmptyString(value.paneId);
  const paneName = nonEmptyString(value.paneName);
  const sessionId = nonEmptyString(value.sessionId);
  const rootSessionId = nonEmptyString(value.rootSessionId);
  if (
    eventId === null ||
    agent === null ||
    workspaceId === null ||
    workspaceName === null ||
    workspaceCwd === null ||
    paneId === null ||
    paneName === null ||
    sessionId === null ||
    rootSessionId === null
  ) {
    return null;
  }
  // capturedAt must be POSITIVE, not merely non-negative: the occurredAt
  // clamp heals TOWARD capturedAt, so an epoch capture would launder an
  // epoch observation straight past it — reject the line instead.
  if (
    !finiteNonNegative(value.occurredAt) ||
    !finiteNonNegative(value.capturedAt) ||
    value.capturedAt === 0
  ) {
    return null;
  }
  if (!isJsonRecord(value.tokens) || !isJsonRecord(value.observation)) return null;
  if (!isJsonRecord(value.observation.tokens)) return null;
  const worktree = value.worktree;
  if (worktree !== undefined && !isWorktree(worktree)) return null;
  if (value.model !== undefined && typeof value.model !== "string") return null;
  return {
    eventId,
    occurredAt: value.occurredAt,
    capturedAt: value.capturedAt,
    agent,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    workspaceId,
    workspaceName,
    workspaceCwd,
    paneId,
    paneName,
    sessionId,
    rootSessionId,
    ...(worktree !== undefined ? { worktree } : {}),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The worktree an event was captured in: a path and a repo, and the
 * branch when there was one. */
function isWorktree(value: unknown): value is NonNullable<UsageEventV2Base["worktree"]> {
  return (
    isJsonRecord(value) &&
    typeof value.path === "string" &&
    typeof value.repo === "string" &&
    (value.branch === undefined || typeof value.branch === "string")
  );
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

/**
 * Add one event's counts into a running set, field by field. A field the
 * source never reported stays absent in the target rather than becoming a
 * zero — the difference between "this provider does not break its counts
 * out" and "it broke them out and there were none".
 *
 * The running `total` this produces is NOT the set's true total: an event
 * that reported only a breakdown contributes nothing to it. Every caller
 * therefore keeps the authoritative sum separately, through [`tokenTotal`],
 * exactly as `UsageStatsTotals` pairs `tokens` with `totalTokens`.
 */
export function addTokenCounts(into: TokenCounts, from: TokenCounts): void {
  for (const key of TOKEN_KEYS) {
    const value = from[key];
    if (value !== undefined) into[key] = (into[key] ?? 0) + value;
  }
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

/** The event's provider-reported cost, or null when it carries none —
 * THE inclusion rule for every money fold (overview totals, provider
 * windows, achievements, weeks): only "provider"-sourced costs enter
 * totals, so a new cost source cannot silently split the folds. */
export function providerCostOf(event: UsageEventV2): number | null {
  return event.costSource === "provider" ? event.costUsd : null;
}
