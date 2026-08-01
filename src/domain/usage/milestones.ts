import { tokenTotal, usageSessionKey, type UsageEventV2 } from "./history";

/**
 * Milestones — all-time achievements recomputed from the full ledger. The
 * ledger is never pruned, so crossing instants are derivable on every run
 * and nothing needs persisting: the ledger IS the trophy cabinet.
 */

export const TOKEN_MILESTONES: readonly number[] = [
  1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12,
];
export const SESSION_MILESTONES: readonly number[] = [10, 100, 1_000, 10_000];

export interface UsageMilestone {
  kind: "tokens" | "sessions";
  threshold: number;
  /** The ledger instant that crossed the threshold. */
  achievedAt: number;
}

export interface UsageMilestones {
  /** Chronological — the crossing order is part of the story. */
  earned: UsageMilestone[];
  /** The token milestone still ahead, with the all-time total so far; null
   * past the top of the ladder. */
  nextTokens: { threshold: number; totalTokens: number } | null;
}

export function usageMilestones(
  events: readonly UsageEventV2[],
): UsageMilestones {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const earned: UsageMilestone[] = [];
  const sessions = new Set<string>();
  let tokens = 0;
  let tokenNext = 0;
  let sessionNext = 0;
  for (const event of ordered) {
    tokens += tokenTotal(event.tokens);
    sessions.add(usageSessionKey(event));
    while (
      tokenNext < TOKEN_MILESTONES.length &&
      tokens >= TOKEN_MILESTONES[tokenNext]
    ) {
      earned.push({
        kind: "tokens",
        threshold: TOKEN_MILESTONES[tokenNext],
        achievedAt: event.occurredAt,
      });
      tokenNext += 1;
    }
    while (
      sessionNext < SESSION_MILESTONES.length &&
      sessions.size >= SESSION_MILESTONES[sessionNext]
    ) {
      earned.push({
        kind: "sessions",
        threshold: SESSION_MILESTONES[sessionNext],
        achievedAt: event.occurredAt,
      });
      sessionNext += 1;
    }
  }
  return {
    earned,
    nextTokens:
      tokenNext < TOKEN_MILESTONES.length
        ? { threshold: TOKEN_MILESTONES[tokenNext], totalTokens: tokens }
        : null,
  };
}
