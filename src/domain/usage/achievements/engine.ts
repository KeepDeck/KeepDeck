import {
  tokenTotal,
  usageSessionKey,
  type UsageEventV2,
  providerCostOf,
} from "../history/event";
import { addMoney } from "../money";
import {
  HOUR_MS,
  localDayNumber,
  shiftDay,
  utcDayStart,
  type LocalDayNumber,
  type UtcDayStart,
} from "../time";
import {
  achievementId,
  earnedTierCount,
  LADDERS,
  type AchievementMetric,
} from "./catalog";

/** Longest-consecutive-days tracker, ORDER-INDEPENDENT: adding a day merges
 * its neighboring runs in O(1) (run lengths are kept valid at run
 * boundaries), so the longest run is the same whatever order days arrive. */
function createStreakTracker() {
  const days = new Set<LocalDayNumber>();
  const runLengthAt = new Map<LocalDayNumber, number>();
  let longest = 0;
  return {
    add(day: LocalDayNumber) {
      if (days.has(day)) return;
      days.add(day);
      const left = runLengthAt.get(shiftDay(day, -1)) ?? 0;
      const right = runLengthAt.get(shiftDay(day, 1)) ?? 0;
      const length = left + 1 + right;
      runLengthAt.set(shiftDay(day, -left), length);
      runLengthAt.set(shiftDay(day, right), length);
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
 * only crossing DATES need chronology, and only the batch view in
 * `./ladders` tracks those. */
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
  const dayTokenTotals = new Map<UtcDayStart, number>();
  const daySessionSets = new Map<UtcDayStart, Set<string>>();
  const dayProviderSets = new Map<UtcDayStart, Set<string>>();
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
      const cost = providerCostOf(event);
      if (cost !== null) {
        spendUsd = addMoney(spendUsd, cost);
      }

      const utcDay = utcDayStart(event.occurredAt);
      const dayTokens = (dayTokenTotals.get(utcDay) ?? 0) + eventTokens;
      dayTokenTotals.set(utcDay, dayTokens);
      maxDayTokens = Math.max(maxDayTokens, dayTokens);

      const key = usageSessionKey(event);
      sessions.add(key);
      const daySessions = daySessionSets.get(utcDay) ?? new Set();
      daySessions.add(key);
      daySessionSets.set(utcDay, daySessions);
      maxDaySessions = Math.max(maxDaySessions, daySessions.size);
      const dayProviders = dayProviderSets.get(utcDay) ?? new Set();
      dayProviders.add(event.agent);
      dayProviderSets.set(utcDay, dayProviders);
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
      if (cost !== null) {
        const sessionSpend = addMoney(sessionSpendTotals.get(key) ?? 0, cost);
        sessionSpendTotals.set(key, sessionSpend);
        maxSessionSpendUsd = Math.max(maxSessionSpendUsd, sessionSpend);
      }

      // The reader's calendar day, NOT the UTC bucket the peaks above use.
      // A streak answers "did I show up today"; a peak answers "how big was
      // the biggest day", and only the first of those is a fact about the
      // person's own clock. The UTC bucket was not merely late here, it was
      // WRONG: it merges days the calendar separates, so working every other
      // local day could read as an unbroken run (see `localDayNumber`).
      //
      // TWO consequences worth naming, because both look like bugs:
      //
      // LEDGER ONLY. The live chip also counts a day proven by a report that
      // has not become spend yet; this fold deliberately does not. An award
      // has to be derivable from the file, or it stops being reproducible —
      // so a day with a report and no spend shows on the chip and not here,
      // and the seam closes the moment anything is spent.
      //
      // NOT REPRODUCIBLE ACROSS ZONES. The event carries no offset, so this
      // folds in whatever calendar the reader is in NOW: fly far enough and
      // the number moves. That is why `reconcileCongratulated` no longer
      // revokes on a value it did not itself move — a badge you earned must
      // not evaporate because you changed timezone.
      streak.add(localDayNumber(event.occurredAt));
    },
    value: (metric) => values[metric](),
    earnedIds() {
      const ids = new Set<string>();
      for (const ladder of LADDERS) {
        const earned = earnedTierCount(values[ladder.metric](), ladder.tiers);
        for (const tier of ladder.tiers.slice(0, earned)) {
          ids.add(achievementId(ladder.metric, tier.threshold));
        }
      }
      return ids;
    },
  };
}
