import { formatTokens, formatUsd } from "./format";
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

/** One catalog entry, flat — what the notifier needs to announce a tier. */
export interface AchievementCatalogEntry {
  id: string;
  metric: AchievementMetric;
  threshold: number;
  title: string;
  icon: string;
}

/** The flat catalog in ladder order (each ladder's tiers ascending). */
export function achievementCatalog(): AchievementCatalogEntry[] {
  return LADDERS.flatMap((ladder) =>
    ladder.tiers.map((tier) => ({
      id: `${ladder.metric}-${tier.threshold}`,
      metric: ladder.metric,
      threshold: tier.threshold,
      title: tier.title,
      icon: tier.icon,
    })),
  );
}

/** Longest-consecutive-days tracker, ORDER-INDEPENDENT: adding a day merges
 * its neighboring runs in O(1) (run lengths are kept valid at run
 * boundaries), so the longest run is the same whatever order days arrive. */
function createStreakTracker() {
  const days = new Set<number>();
  const runLengthAt = new Map<number, number>();
  let longest = 0;
  return {
    add(day: number) {
      if (days.has(day)) return;
      days.add(day);
      const left = runLengthAt.get(day - 1) ?? 0;
      const right = runLengthAt.get(day + 1) ?? 0;
      const length = left + 1 + right;
      runLengthAt.set(day - left, length);
      runLengthAt.set(day + right, length);
      runLengthAt.set(day, length);
      longest = Math.max(longest, length);
    },
    longest: () => longest,
  };
}

/** The metric accumulator — THE one home of the per-event metric math.
 * Every metric is a sum, a set size, or a max over per-key aggregates, so
 * ingestion is ORDER-INDEPENDENT: final values depend only on the multiset
 * of events. That is what lets the notifier fold in appended suffixes
 * incrementally instead of re-sorting the whole unbounded ledger per turn;
 * only crossing DATES need chronology, and only the batch view tracks
 * those. */
export interface AchievementEngine {
  ingest(event: UsageEventV2): void;
  value(metric: AchievementMetric): number;
  /** Every tier id the current values meet. */
  earnedIds(): Set<string>;
}

export function createAchievementEngine(): AchievementEngine {
  const sessions = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  const workspaces = new Set<string>();
  const dayTokenTotals = new Map<number, number>();
  const daySessionSets = new Map<number, Set<string>>();
  const dayProviderSets = new Map<number, Set<string>>();
  const sessionTokenTotals = new Map<string, number>();
  const sessionTurnCounts = new Map<string, number>();
  const sessionMinAt = new Map<string, number>();
  const sessionMaxAt = new Map<string, number>();
  const sessionSpendTotals = new Map<string, number>();
  const streak = createStreakTracker();
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

  const values: Record<AchievementMetric, () => number> = {
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
    streakDays: streak.longest,
    providers: () => providers.size,
    models: () => models.size,
    workspaces: () => workspaces.size,
  };

  return {
    ingest(event) {
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
      const minAt = Math.min(sessionMinAt.get(key) ?? Infinity, event.occurredAt);
      const maxAt = Math.max(sessionMaxAt.get(key) ?? -Infinity, event.occurredAt);
      sessionMinAt.set(key, minAt);
      sessionMaxAt.set(key, maxAt);
      maxSessionSpanMs = Math.max(maxSessionSpanMs, maxAt - minAt);
      if (event.costSource === "provider") {
        const sessionSpend = addMoney(
          sessionSpendTotals.get(key) ?? 0,
          event.costUsd,
        );
        sessionSpendTotals.set(key, sessionSpend);
        maxSessionSpendUsd = Math.max(maxSessionSpendUsd, sessionSpend);
      }

      streak.add(day / DAY_MS);
    },
    value: (metric) => values[metric](),
    earnedIds() {
      const ids = new Set<string>();
      for (const ladder of LADDERS) {
        const value = values[ladder.metric]();
        for (const tier of ladder.tiers) {
          if (value < tier.threshold) break;
          ids.add(`${ladder.metric}-${tier.threshold}`);
        }
      }
      return ids;
    },
  };
}

/** All ladders with crossing dates and current progress, in catalog order.
 * The batch view: sorts chronologically so each crossing is dated at the
 * exact event that crossed it — the ONLY place chronology matters. */
export function usageAchievementLadders(
  events: readonly UsageEventV2[],
): UsageAchievementLadder[] {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const engine = createAchievementEngine();
  const next = LADDERS.map(() => 0);
  const crossings = LADDERS.map(() => new Map<number, number>());

  for (const event of ordered) {
    engine.ingest(event);
    LADDERS.forEach((ladder, index) => {
      const value = engine.value(ladder.metric);
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
      progress: engine.value(ladder.metric),
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

/* ---- Captions: one spec per metric, exhaustive by construction -------- *
 * The Record type forces every new metric to bring its full caption set —
 * a ladder addition that forgets one fails to compile instead of silently
 * rendering "3 / 500" where "$3.42 / $500" was meant. */

interface MetricSpec {
  /** "10M tokens all-time" — the requirement line under a badge title;
   * shared with the unlock notification body. */
  requirement(threshold: number): string;
  /** "5.5B / 10B" — the compact progress caption on an in-progress goal. */
  progress(progress: number, threshold: number): string;
  /** "5,471,316,706 of 10,000,000,000 — 54%" — the tooltip's exact line. */
  exact(progress: number, threshold: number): string;
}

const pctOf = (progress: number, threshold: number) =>
  Math.min(100, Math.floor((progress / threshold) * 100));
const exactInt = (value: number) => Math.floor(value).toLocaleString("en-US");

const tokensSpec = (requirement: (t: string) => string): MetricSpec => ({
  requirement: (t) => requirement(formatTokens(t)),
  progress: (p, t) => `${formatTokens(p)} / ${formatTokens(t)}`,
  exact: (p, t) => `${exactInt(p)} of ${exactInt(t)} — ${pctOf(p, t)}%`,
});

const countSpec = (requirement: (t: number) => string): MetricSpec => ({
  requirement,
  progress: (p, t) => `${Math.floor(p)} / ${t}`,
  exact: (p, t) => `${exactInt(p)} of ${exactInt(t)} — ${pctOf(p, t)}%`,
});

const moneySpec = (requirement: (t: string) => string): MetricSpec => ({
  requirement: (t) => requirement(t.toLocaleString("en-US")),
  progress: (p, t) => `${formatUsd(p)} / $${t.toLocaleString("en-US")}`,
  exact: (p, t) =>
    `${formatUsd(p)} of $${t.toLocaleString("en-US")} — ${pctOf(p, t)}%`,
});

const METRIC_SPECS: Record<AchievementMetric, MetricSpec> = {
  tokens: tokensSpec((t) => `${t} tokens all-time`),
  outputTokens: tokensSpec((t) => `${t} output tokens all-time`),
  cacheTokens: tokensSpec((t) => `${t} cache-read tokens all-time`),
  sessions: countSpec((t) => `${t} session${t === 1 ? "" : "s"} all-time`),
  spendUsd: moneySpec((t) => `$${t} provider-reported spend`),
  dayTokens: tokensSpec((t) => `${t} tokens in one day`),
  daySessions: countSpec((t) => `${t} sessions in one day`),
  dayProviders: countSpec((t) => `${t} providers in one day`),
  sessionTokens: tokensSpec((t) => `${t} tokens in one session`),
  sessionTurns: countSpec((t) => `${t} usage updates in one session`),
  sessionHours: countSpec((t) => `a session ${t} hours long`),
  sessionSpendUsd: moneySpec((t) => `$${t} in one session`),
  streakDays: countSpec((t) => `${t} active days in a row`),
  providers: countSpec((t) => `${t} providers used`),
  models: countSpec((t) => `${t} models used`),
  workspaces: countSpec((t) => `${t} workspaces used`),
};

/** The requirement line under a badge title. Accepts anything carrying a
 * metric and threshold — a full tier or a bare catalog entry. */
export function achievementRequirement(
  item: Pick<UsageAchievement, "metric" | "threshold">,
): string {
  return METRIC_SPECS[item.metric].requirement(item.threshold);
}

/** The compact progress caption on an in-progress goal. */
export function achievementProgress(item: UsageAchievement): string {
  return METRIC_SPECS[item.metric].progress(item.progress, item.threshold);
}

/** The exact-numbers line behind the compact caption (hover tooltip). */
export function achievementExact(item: UsageAchievement): string {
  return METRIC_SPECS[item.metric].exact(item.progress, item.threshold);
}
