import { formatTokens } from "./format";
import {
  addMoney,
  tokenTotal,
  usageSessionKey,
  type UsageEventV2,
} from "./history";

/**
 * Achievements — cumulative ladders recomputed from the never-pruned
 * ledger. Crossing instants are derivable on every run, so nothing needs
 * persisting: the ledger IS the trophy cabinet.
 *
 * Presentation contract (the user's rule): within a ladder, earned tiers
 * show as earned, exactly ONE next tier shows with progress, and the tiers
 * beyond it stay hidden until the previous one is won — a single next goal,
 * not a wall of distant ones. The domain returns full ladders;
 * [`visibleTiers`] applies that rule.
 */

/** What a ladder counts. Determines both the metric and the captions. */
export type AchievementMetric =
  | "tokens"
  | "sessions"
  | "spendUsd"
  | "dayTokens"
  | "streakDays"
  | "providers"
  | "models";

export interface UsageAchievement {
  id: string;
  metric: AchievementMetric;
  threshold: number;
  title: string;
  icon: string;
  /** The ledger instant that crossed the threshold; null while locked. */
  achievedAt: number | null;
  /** The metric's current all-time value. */
  progress: number;
}

export interface UsageAchievementLadder {
  metric: AchievementMetric;
  /** Ascending; earned prefix, then locked. */
  tiers: UsageAchievement[];
}

interface TierSpec {
  threshold: number;
  title: string;
  icon: string;
}

const LADDERS: { metric: AchievementMetric; tiers: TierSpec[] }[] = [
  {
    metric: "tokens",
    tiers: [
      { threshold: 1e6, title: "First Million", icon: "🌱" },
      { threshold: 1e7, title: "Picking Up Steam", icon: "⚡" },
      { threshold: 1e8, title: "Heavy Rotation", icon: "🔥" },
      { threshold: 1e9, title: "Billion Club", icon: "💎" },
      { threshold: 1e10, title: "Token Tycoon", icon: "🏆" },
      { threshold: 1e11, title: "Galactic Scale", icon: "🌌" },
      { threshold: 1e12, title: "Trillionaire", icon: "🚀" },
    ],
  },
  {
    metric: "sessions",
    tiers: [
      { threshold: 1, title: "Hello, Agent", icon: "🤝" },
      { threshold: 10, title: "First Steps", icon: "🎯" },
      { threshold: 100, title: "Century", icon: "🏅" },
      { threshold: 1_000, title: "Workhorse", icon: "⚙️" },
      { threshold: 10_000, title: "Legend", icon: "🎖️" },
    ],
  },
  {
    metric: "spendUsd",
    tiers: [
      { threshold: 1, title: "First Dollar", icon: "🪙" },
      { threshold: 10, title: "Coffee Money", icon: "☕" },
      { threshold: 100, title: "Serious Business", icon: "💼" },
      { threshold: 1_000, title: "Deep Pockets", icon: "💰" },
      { threshold: 10_000, title: "High Roller", icon: "🎰" },
      { threshold: 100_000, title: "Venture Scale", icon: "🏦" },
    ],
  },
  {
    metric: "dayTokens",
    tiers: [
      { threshold: 1e6, title: "Warm Afternoon", icon: "☀️" },
      { threshold: 1e7, title: "Full Throttle", icon: "🏎️" },
      { threshold: 1e8, title: "Marathon", icon: "🏃" },
      { threshold: 1e9, title: "Supernova", icon: "💥" },
    ],
  },
  {
    metric: "streakDays",
    tiers: [
      { threshold: 3, title: "Hat-Trick", icon: "🎩" },
      { threshold: 7, title: "Full Week", icon: "📅" },
      { threshold: 14, title: "Fortnight", icon: "🌗" },
      { threshold: 30, title: "Iron Month", icon: "🛡️" },
      { threshold: 100, title: "Perpetual Motion", icon: "🔄" },
    ],
  },
  {
    metric: "providers",
    tiers: [
      { threshold: 2, title: "Two-Timer", icon: "🎭" },
      { threshold: 3, title: "Polyglot", icon: "🌐" },
      { threshold: 4, title: "Collector", icon: "🧩" },
    ],
  },
  {
    metric: "models",
    tiers: [
      { threshold: 3, title: "Curious", icon: "🔍" },
      { threshold: 10, title: "Explorer", icon: "🧭" },
      { threshold: 25, title: "Cartographer", icon: "🗺️" },
    ],
  },
];

const DAY_MS = 24 * 60 * 60 * 1_000;

/** All ladders with crossing dates and current progress, in catalog order. */
export function usageAchievementLadders(
  events: readonly UsageEventV2[],
): UsageAchievementLadder[] {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);

  const sessions = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  const dayTotals = new Map<number, number>();
  let tokens = 0;
  let spendUsd = 0;
  let maxDayTokens = 0;
  let streakDay = Number.NaN;
  let streak = 0;
  let longestStreak = 0;

  const metrics: Record<AchievementMetric, () => number> = {
    tokens: () => tokens,
    sessions: () => sessions.size,
    spendUsd: () => spendUsd,
    dayTokens: () => maxDayTokens,
    streakDays: () => longestStreak,
    providers: () => providers.size,
    models: () => models.size,
  };

  const next = LADDERS.map(() => 0);
  const crossings = LADDERS.map(() => new Map<number, number>());

  for (const event of ordered) {
    tokens += tokenTotal(event.tokens);
    sessions.add(usageSessionKey(event));
    providers.add(event.agent);
    if (event.model !== undefined) models.add(event.model);
    if (event.costSource === "provider") {
      spendUsd = addMoney(spendUsd, event.costUsd);
    }

    const day = Math.floor(event.occurredAt / DAY_MS) * DAY_MS;
    const dayTotal = (dayTotals.get(day) ?? 0) + tokenTotal(event.tokens);
    dayTotals.set(day, dayTotal);
    maxDayTokens = Math.max(maxDayTokens, dayTotal);

    // Events arrive time-sorted, so days are non-decreasing: a same-day
    // event keeps the streak, the very next day extends it, a gap resets.
    if (day !== streakDay) {
      streak = day - streakDay === DAY_MS ? streak + 1 : 1;
      streakDay = day;
      longestStreak = Math.max(longestStreak, streak);
    }

    LADDERS.forEach((ladder, index) => {
      const value = metrics[ladder.metric]();
      while (
        next[index] < ladder.tiers.length &&
        value >= ladder.tiers[next[index]].threshold
      ) {
        crossings[index].set(
          ladder.tiers[next[index]].threshold,
          event.occurredAt,
        );
        next[index] += 1;
      }
    });
  }

  return LADDERS.map((ladder, index) => ({
    metric: ladder.metric,
    tiers: ladder.tiers.map((tier) => ({
      id: `${ladder.metric}-${tier.threshold}`,
      metric: ladder.metric,
      threshold: tier.threshold,
      title: tier.title,
      icon: tier.icon,
      achievedAt: crossings[index].get(tier.threshold) ?? null,
      progress: metrics[ladder.metric](),
    })),
  }));
}

/** Every earned tier across ladders, freshest first (the Steam-style
 * trophy-case order) — also the notifier's diff surface. */
export function earnedAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders
    .flatMap((ladder) => ladder.tiers.filter((tier) => tier.achievedAt !== null))
    .sort((left, right) => (right.achievedAt ?? 0) - (left.achievedAt ?? 0));
}

/** The user's disclosure rule, one goal per ladder: only the FIRST locked
 * tier is ever visible — tiers beyond it stay hidden until it is won. A
 * completed ladder contributes nothing. */
export function nextAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders.flatMap((ladder) => {
    const next = ladder.tiers.find((tier) => tier.achievedAt === null);
    return next ? [next] : [];
  });
}

/** "10M tokens all-time", "7 active days in a row" — the requirement line
 * under a badge title; shared with the unlock notification body. */
export function achievementRequirement(item: UsageAchievement): string {
  switch (item.metric) {
    case "tokens":
      return `${formatTokens(item.threshold)} tokens all-time`;
    case "sessions":
      return `${item.threshold} session${item.threshold === 1 ? "" : "s"} all-time`;
    case "spendUsd":
      return `$${item.threshold.toLocaleString("en-US")} provider-reported spend`;
    case "dayTokens":
      return `${formatTokens(item.threshold)} tokens in one day`;
    case "streakDays":
      return `${item.threshold} active days in a row`;
    case "providers":
      return `${item.threshold} providers used`;
    case "models":
      return `${item.threshold} models used`;
  }
}

/** "5.5B / 10B" — the progress caption on the one visible locked tier. */
export function achievementProgress(item: UsageAchievement): string {
  switch (item.metric) {
    case "tokens":
    case "dayTokens":
      return `${formatTokens(item.progress)} / ${formatTokens(item.threshold)}`;
    case "spendUsd":
      return `$${item.progress < 100 ? item.progress.toFixed(2) : Math.round(item.progress).toLocaleString("en-US")} / $${item.threshold.toLocaleString("en-US")}`;
    default:
      return `${item.progress} / ${item.threshold}`;
  }
}
