import type { TokenCounts } from "@keepdeck/plugin-api";
import { finiteNonNegative } from "./guards";
import type { UsageEventCommon, UsageEventV2 } from "./event";

/**
 * The salvage of a schema-1 ledger line — FROZEN: it reads what builds
 * before schema 2 wrote, so the agent ids it names are facts of those old
 * files, not knowledge of today's agents. Nothing new is ever written in
 * this shape; the line is rewritten as v2 on the next compaction.
 *
 * V1 token deltas from the other agents remain trustworthy, but locally
 * estimated costs are discarded. claude's v1 token counters came from a
 * non-cumulative status-line field, so only its positive provider-reported
 * cost deltas survive, and its counters are dropped.
 */

/** The agent whose v1 counters cannot be trusted. */
const AGENT_WITH_UNTRUSTED_V1_COUNTERS = "claude";

/** Whether a v1 line names a cost source v1 knew. */
export function isV1CostSource(value: unknown): boolean {
  return value === "reported" || value === "estimated" || value === "unavailable";
}

/** What decoding a v1 line already read, in the shape v2 shares. */
export interface V1Line {
  common: UsageEventCommon;
  tokens: TokenCounts;
  observedTokens: TokenCounts;
  observationCost: number | undefined;
  costSource: unknown;
  costUsd: unknown;
}

/** The v2 event a v1 line becomes, or null when nothing of it is
 * trustworthy. */
export function salvageV1Event(line: V1Line, schemaVersion: UsageEventV2["schemaVersion"]): UsageEventV2 | null {
  const { common, observationCost } = line;
  const untrusted = common.agent === AGENT_WITH_UNTRUSTED_V1_COUNTERS;
  const observation = {
    tokens: untrusted ? {} : line.observedTokens,
    ...(observationCost !== undefined ? { costUsd: observationCost } : {}),
  };
  const providerCost =
    line.costSource === "reported" && finiteNonNegative(line.costUsd) ? line.costUsd : undefined;
  if (untrusted) {
    if (providerCost === undefined || providerCost <= 0) return null;
    return { ...common, schemaVersion, tokens: {}, costSource: "provider", costUsd: providerCost, observation };
  }
  return providerCost !== undefined
    ? { ...common, schemaVersion, tokens: line.tokens, costSource: "provider", costUsd: providerCost, observation }
    : { ...common, schemaVersion, tokens: line.tokens, costSource: "unavailable", observation };
}
