import {
  asFiniteNumber,
  asNonEmptyString,
  isJsonRecord,
  reportedLimits,
  type ApiActivity,
  type UsageNormalizer,
} from "@keepdeck/plugin-api";

/**
 * A reporter that re-sends the SAME frozen account limits on a timer, with
 * no capture time of its own — the kind the host gates behind API activity
 * (`NormalizedUsage.accountActivity`). Spoken through the contract alone, so
 * a core test drives the gate without naming the plugin that has the shape:
 * what the plugin declares is its own tests' business, what the host does
 * with the declaration is these tests'.
 *
 * The payload is this fake's own: `weekPct` (null: no limits in the report),
 * and the session's cumulative API counters beside it. Missing counters are
 * no witness (`accountActivity: null`), exactly as the contract reads it.
 */
export interface GatedLimitsReport {
  agent: string;
  sessionId: string;
  weekPct: number | null;
  resetsAt: number;
  costUsd: number;
  apiDurationMs: number;
}

export const gatedLimitsNormalizer: UsageNormalizer = (payload, at) => {
  if (!isJsonRecord(payload)) return null;
  const sessionId = asNonEmptyString(payload.sessionId);
  const weekPct = asFiniteNumber(payload.weekPct);
  const resetsAt = asFiniteNumber(payload.resetsAt) ?? null;
  const costUsd = asFiniteNumber(payload.costUsd);
  const apiDurationMs = asFiniteNumber(payload.apiDurationMs);
  const activity: ApiActivity | null =
    sessionId !== undefined && costUsd !== undefined && apiDurationMs !== undefined
      ? { sessionId, costUsd, apiDurationMs }
      : null;
  return {
    account:
      weekPct === undefined
        ? null
        : reportedLimits([{ usedPct: weekPct, resetsAt, windowMinutes: 10_080 }], at),
    pane: null,
    accountActivity: activity,
  };
};

/** One report of that reporter, as a pane would send it. */
export function gatedLimitsReport(
  agent: string,
  sessionId: string,
  weekPct: number | null,
  costUsd: number,
  apiDurationMs: number,
  resetsAt = 1_800_000_000_000,
): GatedLimitsReport {
  return { agent, sessionId, weekPct, resetsAt, costUsd, apiDurationMs };
}
