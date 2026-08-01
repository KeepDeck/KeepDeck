import { formatTokens } from "./format";
import {
  addMoney,
  tokenTotal,
  usageSessionKey,
  type UsageEventV2,
} from "./history";

/**
 * Achievements — cumulative ladders and one-off badges (a one-off is simply
 * a single-tier ladder), recomputed from the never-pruned ledger. Crossing
 * instants are derivable on every run, so nothing needs persisting: the
 * ledger IS the trophy cabinet.
 *
 * Presentation contract (the user's rule): a ladder exposes its earned
 * tiers, ONE in-progress goal (the first locked tier), and the rest as
 * visibly locked future tiers — [`earnedAchievements`],
 * [`nextAchievements`] and [`lockedAchievements`] are those three views.
 */

/** What a ladder counts. Determines both the metric and the captions. */
export type AchievementMetric =
  | "tokens"
  | "outputTokens"
  | "cacheTokens"
  | "sessions"
  | "spendUsd"
  | "dayTokens"
  | "daySessions"
  | "dayProviders"
  | "sessionTokens"
  | "sessionTurns"
  | "sessionHours"
  | "sessionSpendUsd"
  | "streakDays"
  | "providers"
  | "models"
  | "workspaces";

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
    metric: "outputTokens",
    tiers: [
      { threshold: 1e6, title: "Prolific", icon: "✍️" },
      { threshold: 1e7, title: "Author", icon: "📝" },
      { threshold: 1e8, title: "Novelist", icon: "📚" },
      { threshold: 1e9, title: "Printing Press", icon: "🖨️" },
    ],
  },
  {
    metric: "cacheTokens",
    tiers: [
      { threshold: 1e8, title: "Warm Cache", icon: "💾" },
      { threshold: 1e9, title: "Total Recall", icon: "🧠" },
      { threshold: 1e10, title: "Cache Money", icon: "🏛️" },
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
    metric: "daySessions",
    tiers: [
      { threshold: 5, title: "Juggler", icon: "🤹" },
      { threshold: 15, title: "Ringmaster", icon: "🎪" },
      { threshold: 40, title: "Hive Mind", icon: "🐝" },
    ],
  },
  {
    // One-off: every provider at the table on the same day.
    metric: "dayProviders",
    tiers: [{ threshold: 4, title: "Full House", icon: "🎴" }],
  },
  {
    metric: "sessionTokens",
    tiers: [
      { threshold: 1e7, title: "Deep Dive", icon: "🤿" },
      { threshold: 1e8, title: "Leviathan", icon: "🐋" },
      { threshold: 1e9, title: "White Whale", icon: "🦭" },
    ],
  },
  {
    // One-off: a hundred recorded turns inside one session.
    metric: "sessionTurns",
    tiers: [{ threshold: 100, title: "The Grind", icon: "🪨" }],
  },
  {
    // One-off: a session that ran for a working day.
    metric: "sessionHours",
    tiers: [{ threshold: 8, title: "Marathon Session", icon: "🌙" }],
  },
  {
    // One-off: three digits of provider-reported cost in one session.
    metric: "sessionSpendUsd",
    tiers: [{ threshold: 100, title: "All In", icon: "🃏" }],
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
  {
    metric: "workspaces",
    tiers: [
      { threshold: 2, title: "Side Project", icon: "🗂️" },
      { threshold: 5, title: "Portfolio", icon: "🏗️" },
      { threshold: 10, title: "Empire Builder", icon: "🌆" },
    ],
  },
];

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** All ladders with crossing dates and current progress, in catalog order. */
export function usageAchievementLadders(
  events: readonly UsageEventV2[],
): UsageAchievementLadder[] {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);

  const sessions = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  const workspaces = new Set<string>();
  const dayTokenTotals = new Map<number, number>();
  const daySessionSets = new Map<number, Set<string>>();
  const dayProviderSets = new Map<number, Set<string>>();
  const sessionTokenTotals = new Map<string, number>();
  const sessionTurnCounts = new Map<string, number>();
  const sessionFirstAt = new Map<string, number>();
  const sessionSpendTotals = new Map<string, number>();
  let tokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let spendUsd = 0;
  let maxDayTokens = 0;
  let maxDaySessions = 0;
  let maxDayProviders = 0;
  let maxSessionTokens = 0;
  let maxSessionTurns = 0;
  let maxSessionSpanMs = 0;
  let maxSessionSpendUsd = 0;
  let streakDay = Number.NaN;
  let streak = 0;
  let longestStreak = 0;

  const metrics: Record<AchievementMetric, () => number> = {
    tokens: () => tokens,
    outputTokens: () => outputTokens,
    cacheTokens: () => cacheTokens,
    sessions: () => sessions.size,
    spendUsd: () => spendUsd,
    dayTokens: () => maxDayTokens,
    daySessions: () => maxDaySessions,
    dayProviders: () => maxDayProviders,
    sessionTokens: () => maxSessionTokens,
    sessionTurns: () => maxSessionTurns,
    sessionHours: () => maxSessionSpanMs / HOUR_MS,
    sessionSpendUsd: () => maxSessionSpendUsd,
    streakDays: () => longestStreak,
    providers: () => providers.size,
    models: () => models.size,
    workspaces: () => workspaces.size,
  };

  const next = LADDERS.map(() => 0);
  const crossings = LADDERS.map(() => new Map<number, number>());

  for (const event of ordered) {
    const eventTokens = tokenTotal(event.tokens);
    tokens += eventTokens;
    outputTokens += event.tokens.output ?? 0;
    cacheTokens += event.tokens.cacheRead ?? 0;
    providers.add(event.agent);
    workspaces.add(event.workspaceId);
    if (event.model !== undefined) models.add(event.model);
    if (event.costSource === "provider") {
      spendUsd = addMoney(spendUsd, event.costUsd);
    }

    const day = Math.floor(event.occurredAt / DAY_MS) * DAY_MS;
    const dayTokens = (dayTokenTotals.get(day) ?? 0) + eventTokens;
    dayTokenTotals.set(day, dayTokens);
    maxDayTokens = Math.max(maxDayTokens, dayTokens);

    const key = usageSessionKey(event);
    sessions.add(key);
    const daySessions = daySessionSets.get(day) ?? new Set();
    daySessions.add(key);
    daySessionSets.set(day, daySessions);
    maxDaySessions = Math.max(maxDaySessions, daySessions.size);
    const dayProviders = dayProviderSets.get(day) ?? new Set();
    dayProviders.add(event.agent);
    dayProviderSets.set(day, dayProviders);
    maxDayProviders = Math.max(maxDayProviders, dayProviders.size);

    const sessionTokens = (sessionTokenTotals.get(key) ?? 0) + eventTokens;
    sessionTokenTotals.set(key, sessionTokens);
    maxSessionTokens = Math.max(maxSessionTokens, sessionTokens);
    const sessionTurns = (sessionTurnCounts.get(key) ?? 0) + 1;
    sessionTurnCounts.set(key, sessionTurns);
    maxSessionTurns = Math.max(maxSessionTurns, sessionTurns);
    const firstAt = sessionFirstAt.get(key) ?? event.occurredAt;
    sessionFirstAt.set(key, firstAt);
    maxSessionSpanMs = Math.max(maxSessionSpanMs, event.occurredAt - firstAt);
    if (event.costSource === "provider") {
      const sessionSpend = addMoney(
        sessionSpendTotals.get(key) ?? 0,
        event.costUsd,
      );
      sessionSpendTotals.set(key, sessionSpend);
      maxSessionSpendUsd = Math.max(maxSessionSpendUsd, sessionSpend);
    }

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

/** The in-progress view, one goal per ladder: the FIRST locked tier — the
 * one the user is actively walking toward. A completed ladder contributes
 * nothing. */
export function nextAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders.flatMap((ladder) => {
    const next = ladder.tiers.find((tier) => tier.achievedAt === null);
    return next ? [next] : [];
  });
}

/** The locked tail: every tier BEYOND each ladder's in-progress goal —
 * earnable in theory, reachable only after the previous tier is won. */
export function lockedAchievements(
  ladders: readonly UsageAchievementLadder[],
): UsageAchievement[] {
  return ladders.flatMap((ladder) => {
    const first = ladder.tiers.findIndex((tier) => tier.achievedAt === null);
    return first === -1 ? [] : ladder.tiers.slice(first + 1);
  });
}

/** "10M tokens all-time", "7 active days in a row" — the requirement line
 * under a badge title; shared with the unlock notification body. */
export function achievementRequirement(item: UsageAchievement): string {
  switch (item.metric) {
    case "tokens":
      return `${formatTokens(item.threshold)} tokens all-time`;
    case "outputTokens":
      return `${formatTokens(item.threshold)} output tokens all-time`;
    case "cacheTokens":
      return `${formatTokens(item.threshold)} cache-read tokens all-time`;
    case "sessions":
      return `${item.threshold} session${item.threshold === 1 ? "" : "s"} all-time`;
    case "spendUsd":
      return `$${item.threshold.toLocaleString("en-US")} provider-reported spend`;
    case "dayTokens":
      return `${formatTokens(item.threshold)} tokens in one day`;
    case "daySessions":
      return `${item.threshold} sessions in one day`;
    case "dayProviders":
      return `${item.threshold} providers in one day`;
    case "sessionTokens":
      return `${formatTokens(item.threshold)} tokens in one session`;
    case "sessionTurns":
      return `${item.threshold} turns in one session`;
    case "sessionHours":
      return `a session ${item.threshold} hours long`;
    case "sessionSpendUsd":
      return `$${item.threshold.toLocaleString("en-US")} in one session`;
    case "streakDays":
      return `${item.threshold} active days in a row`;
    case "providers":
      return `${item.threshold} providers used`;
    case "models":
      return `${item.threshold} models used`;
    case "workspaces":
      return `${item.threshold} workspaces used`;
  }
}

/** "5.5B / 10B" — the progress caption on an in-progress goal. */
export function achievementProgress(item: UsageAchievement): string {
  switch (item.metric) {
    case "tokens":
    case "outputTokens":
    case "cacheTokens":
    case "dayTokens":
    case "sessionTokens":
      return `${formatTokens(item.progress)} / ${formatTokens(item.threshold)}`;
    case "spendUsd":
    case "sessionSpendUsd":
      return `$${
        item.progress < 100
          ? item.progress.toFixed(2)
          : Math.round(item.progress).toLocaleString("en-US")
      } / $${item.threshold.toLocaleString("en-US")}`;
    default:
      return `${Math.floor(item.progress)} / ${item.threshold}`;
  }
}
