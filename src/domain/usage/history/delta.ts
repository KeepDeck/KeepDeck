import type { PaneUsage, TokenCounts } from "@keepdeck/plugin-api";
import { roundMoney } from "../money";
import { TOKEN_KEYS, type UsageObservation } from "./event";
import { finiteNonNegative } from "./guards";

/**
 * Cumulative pane snapshot → durable delta. The one place that knows how a
 * provider's monotonically growing counters become the non-negative
 * increments the ledger stores, including the reset and resumed-session
 * rules.
 */

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
      if (!hasPreviousCost || rawDelta > 0) {
        providerCostUsd = roundMoney(rawDelta);
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
