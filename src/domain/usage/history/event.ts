import type { TokenCounts } from "@keepdeck/plugin-api";
import { addMoney } from "../money";
import type { UsageTeam } from "./capture";
import { finiteNonNegative } from "./guards";

/**
 * One row of the usage ledger as the page reads it — the shape every stats
 * consumer folds.
 *
 * The ledger lives in the core (`keepdeck-usage`): it books every provider
 * call once, and hands the page its history compacted. A row is one booked
 * call, or a quarter-hour bucket of one session's calls under one model; its
 * fields read the same either way, and the two weights say how many events
 * and provider calls it stands for. A fold that counts things counts the
 * weights, never the rows.
 *
 * The core prices every row as it serves it — tokens × the model maker's
 * list price in effect at the time — and the page never repeats the
 * formula: it reads `costUsd` and how far to trust it (`costBasis`).
 */
interface UsageRowBase {
  eventId: string;
  occurredAt: number;
  capturedAt: number;
  agent: string;
  /** The booked model key, `<provider>/<model id>`. */
  model?: string;
  /** The price catalogue's name for the model, when it knows the model. */
  modelName?: string;
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
  /** The team the pane was on when the calls were booked — absent for a
   * pane on no team, and for every row booked before teams were recorded. */
  team?: UsageTeam;
  /** In the canonical classes: fresh `input`, `output` with any reasoning
   * in it (`reasoning` is its share), and the cache classes beside them;
   * `total` is the billed sum. */
  tokens: TokenCounts;
  /** Booked events the row stands for — 1 for an event. */
  count: number;
  /** Provider calls among them: a call restated with more tokens is an
   * event, not a call. */
  calls: number;
}

/** How far a row's cost can be trusted:
 * - `estimated` — the maker's list price in effect at the time, every
 *   class priced;
 * - `approximate` — priced, by a stand-in somewhere (the earliest known
 *   price for older usage, base rates for a mode or tier, the input rate
 *   for an unpriced cache class);
 * - `unpriced` — no price is known for the model: shown as "—", never $0. */
export type CostBasis = "estimated" | "approximate" | "unpriced";

export type UsageRow = UsageRowBase &
  (
    | { costBasis: "estimated" | "approximate"; costUsd: number }
    | { costBasis: "unpriced"; costUsd?: never }
  );

/** The provider in a booked model key — the `<provider>` of
 * `<provider>/<model id>`, the key's documented shape above — or null for a
 * row booked before per-model usage, whose key names none. */
export function modelProvider(row: Pick<UsageRow, "model">): string | null {
  const model = row.model ?? "";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

/** The classes a token set is added up in, `total` among them. */
const TOKEN_KEYS: readonly (keyof TokenCounts)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
  "total",
];

export function usageSessionKey(
  value: Pick<UsageRow, "agent" | "sessionId">,
): string {
  return `${value.agent}\0${value.sessionId}`;
}

/** A row's tokens: its billed total, or the sum of the billed classes when
 * it carries none — reasoning is a share of output, never added again. */
export function tokenTotal(tokens: TokenCounts): number {
  if (finiteNonNegative(tokens.total)) return tokens.total;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheWrite ?? 0) +
    (tokens.cacheWrite1h ?? 0)
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

/** The row's cost, or null when no price is known for its model — THE
 * inclusion rule for every money fold: an unpriced row adds nothing to a
 * sum, and is never read as free. */
export function costOf(row: UsageRow): number | null {
  return row.costBasis === "unpriced" ? null : row.costUsd;
}

/**
 * What a set of rows cost, and how much of it a price covers — the running
 * state of every fold that shows money. Kept in one shape and added to in
 * one place ([`addCost`]), so the overview, the weeks, the sessions and the
 * provider windows cannot count money four different ways.
 */
export interface CostTally {
  /** The priced rows' cost. */
  costUsd: number;
  /** Events that carried a price: none means nothing to show but "—". */
  pricedEvents: number;
  /** Priced events whose price was a stand-in. */
  approximateEvents: number;
  /** Tokens on models without a known price — not in `costUsd`. */
  unpricedTokens: number;
}

export function emptyCostTally(): CostTally {
  return { costUsd: 0, pricedEvents: 0, approximateEvents: 0, unpricedTokens: 0 };
}

/** Add one row's cost into a tally. */
export function addCost(into: CostTally, row: UsageRow): void {
  const cost = costOf(row);
  if (cost === null) {
    into.unpricedTokens += tokenTotal(row.tokens);
    return;
  }
  into.costUsd = addMoney(into.costUsd, cost);
  into.pricedEvents += row.count;
  if (row.costBasis === "approximate") into.approximateEvents += row.count;
}
