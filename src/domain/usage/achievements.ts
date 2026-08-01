import { tokenTotal, usageSessionKey, type UsageEventV2 } from "./history";

/**
 * Achievements — the full catalog, locked entries included, recomputed from
 * the never-pruned ledger. Crossing instants are derivable on every run, so
 * nothing needs persisting: the ledger IS the trophy cabinet. The locked
 * tail with visible progress is deliberately part of the output — "what can
 * I still earn" is the hook.
 */

export interface UsageAchievement {
  id: string;
  kind: "tokens" | "sessions";
  threshold: number;
  title: string;
  icon: string;
  /** The ledger instant that crossed the threshold; null while locked. */
  achievedAt: number | null;
  /** All-time progress toward the threshold: total tokens or distinct
   * sessions, whichever the achievement counts. */
  progress: number;
}

const TOKEN_LADDER = [
  { threshold: 1e6, title: "First Million", icon: "🌱" },
  { threshold: 1e7, title: "Picking Up Steam", icon: "⚡" },
  { threshold: 1e8, title: "Heavy Rotation", icon: "🔥" },
  { threshold: 1e9, title: "Billion Club", icon: "💎" },
  { threshold: 1e10, title: "Token Tycoon", icon: "🏆" },
  { threshold: 1e11, title: "Galactic Scale", icon: "🌌" },
  { threshold: 1e12, title: "Trillionaire", icon: "🚀" },
] as const;

const SESSION_LADDER = [
  { threshold: 10, title: "First Steps", icon: "🎯" },
  { threshold: 100, title: "Century", icon: "🏅" },
  { threshold: 1_000, title: "Workhorse", icon: "⚙️" },
  { threshold: 10_000, title: "Legend", icon: "🎖️" },
] as const;

/** The catalog in ladder order — tokens ascending, then sessions ascending —
 * so the gallery reads as a progression rather than a trophy dump. */
export function usageAchievements(
  events: readonly UsageEventV2[],
): UsageAchievement[] {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const sessions = new Set<string>();
  const tokenCrossings = new Map<number, number>();
  const sessionCrossings = new Map<number, number>();
  let tokens = 0;
  let tokenNext = 0;
  let sessionNext = 0;
  for (const event of ordered) {
    tokens += tokenTotal(event.tokens);
    sessions.add(usageSessionKey(event));
    while (
      tokenNext < TOKEN_LADDER.length &&
      tokens >= TOKEN_LADDER[tokenNext].threshold
    ) {
      tokenCrossings.set(TOKEN_LADDER[tokenNext].threshold, event.occurredAt);
      tokenNext += 1;
    }
    while (
      sessionNext < SESSION_LADDER.length &&
      sessions.size >= SESSION_LADDER[sessionNext].threshold
    ) {
      sessionCrossings.set(SESSION_LADDER[sessionNext].threshold, event.occurredAt);
      sessionNext += 1;
    }
  }
  return [
    ...TOKEN_LADDER.map((entry) => ({
      id: `tokens-${entry.threshold}`,
      kind: "tokens" as const,
      threshold: entry.threshold,
      title: entry.title,
      icon: entry.icon,
      achievedAt: tokenCrossings.get(entry.threshold) ?? null,
      progress: tokens,
    })),
    ...SESSION_LADDER.map((entry) => ({
      id: `sessions-${entry.threshold}`,
      kind: "sessions" as const,
      threshold: entry.threshold,
      title: entry.title,
      icon: entry.icon,
      achievedAt: sessionCrossings.get(entry.threshold) ?? null,
      progress: sessions.size,
    })),
  ];
}
