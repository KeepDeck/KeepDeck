import type { TokenCounts } from "@keepdeck/plugin-api";
import { finiteNonNegative } from "./guards";

/**
 * One row of the usage ledger as the page reads it — the shape every stats
 * consumer folds.
 *
 * The ledger lives in the core (`keepdeck-usage`): it books every pane
 * report, and hands the page its history compacted. A row is one recorded
 * event, or a quarter-hour bucket of one session's events under one model;
 * its fields read the same either way, and the three weights say how many
 * events, provider calls and priced events it stands for. A fold that counts
 * things counts the weights, never the rows.
 */
interface UsageRowBase {
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
  /** Recorded events the row stands for — 1 for an event. */
  count: number;
  /** Provider calls: an event is one call, its two reported halves joined. */
  calls: number;
  /** Events among them that carried a provider price. */
  costEvents: number;
}

export type UsageRow = UsageRowBase &
  (
    | { costSource: "provider"; costUsd: number }
    | { costSource: "unavailable"; costUsd?: never }
  );

const TOKEN_KEYS: readonly (keyof TokenCounts)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
];

export function usageSessionKey(
  value: Pick<UsageRow, "agent" | "sessionId">,
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
 * Add one row's counts into a running set, field by field. A field the
 * source never reported stays absent in the target rather than becoming a
 * zero — the difference between "this provider does not break its counts
 * out" and "it broke them out and there were none".
 *
 * The running `total` this produces is NOT the set's true total: a row that
 * reported only a breakdown contributes nothing to it. Every caller
 * therefore keeps the authoritative sum separately, through [`tokenTotal`],
 * exactly as `UsageStatsTotals` pairs `tokens` with `totalTokens`.
 */
export function addTokenCounts(into: TokenCounts, from: TokenCounts): void {
  for (const key of TOKEN_KEYS) {
    const value = from[key];
    if (value !== undefined) into[key] = (into[key] ?? 0) + value;
  }
}

/** The row's provider-reported cost, or null when it carries none —
 * THE inclusion rule for every money fold (overview totals, provider
 * windows, achievements, weeks): only "provider"-sourced costs enter
 * totals, so a new cost source cannot silently split the folds. */
export function providerCostOf(row: UsageRow): number | null {
  return row.costSource === "provider" ? row.costUsd : null;
}
