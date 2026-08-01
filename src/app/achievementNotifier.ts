import {
  achievementRequirement,
  earnedAchievements,
  usageAchievementLadders,
  type UsageAchievement,
} from "../domain/usage/achievements";
import {
  loadNotifiedAchievements,
  saveNotifiedAchievements,
} from "../ipc/achievements";
import { notify } from "./notificationCenter";
import {
  getUsageHistorySnapshot,
  subscribeUsageHistory,
} from "./usageHistoryManager";

/**
 * Congratulates on newly earned achievements. Earned state is a pure
 * recomputation from the ledger, so "new" is a DIFF against the persisted
 * already-congratulated set — which makes awards retroactive by
 * construction: a release that ships ladders the ledger already satisfies
 * congratulates on the first launch after the update, exactly like a live
 * crossing would. Every award gets its OWN notification — no summary
 * batching (user decision): each unlock is its own moment, even in a
 * retroactive pile.
 */

let notified: Set<string> | null = null;
let unsubscribe: (() => void) | null = null;
let writes: Promise<void> = Promise.resolve();

export function initAchievementNotifier(): void {
  if (unsubscribe) return;
  void loadNotifiedAchievements()
    .then((json) => {
      notified = decode(json);
      check();
    })
    .catch(() => {
      // An unreadable baseline congratulates from scratch (batched) rather
      // than staying silent forever.
      notified = new Set();
      check();
    });
  unsubscribe = subscribeUsageHistory(check);
}

function check(): void {
  const congratulated = notified;
  if (congratulated === null) return; // baseline not loaded yet
  const snapshot = getUsageHistorySnapshot();
  if (!snapshot.ready) return;
  const earned = earnedAchievements(usageAchievementLadders(snapshot.events));
  const fresh = earned.filter((item) => !congratulated.has(item.id));
  if (fresh.length === 0) return;
  for (const item of fresh) congratulated.add(item.id);
  persist(congratulated);
  announce(fresh);
}

function announce(fresh: UsageAchievement[]): void {
  for (const item of fresh) {
    notify({
      title: `Achievement unlocked: ${item.title}`,
      body: achievementRequirement(item),
      icon: item.icon,
      // The click destination is the trophy case, not Settings.
      source: { type: "stats", tab: "achievements" },
      tag: `achievement:${item.id}`,
    });
  }
}

function persist(congratulated: ReadonlySet<string>): void {
  const json = JSON.stringify({
    version: 1,
    notified: [...congratulated].sort(),
  });
  writes = writes
    .catch(() => {})
    .then(() => saveNotifiedAchievements(json))
    // Best-effort: a failed save means at worst a repeated congratulation.
    .catch(() => {});
}

function decode(json: string | null): Set<string> {
  if (json === null) return new Set();
  try {
    const value = JSON.parse(json) as { notified?: unknown };
    if (Array.isArray(value.notified)) {
      return new Set(
        value.notified.filter((id): id is string => typeof id === "string"),
      );
    }
  } catch {
    // fall through to the empty baseline
  }
  return new Set();
}

/** Test hook: forget the baseline, the subscription and pending writes. */
export function resetAchievementNotifier(): void {
  notified = null;
  unsubscribe?.();
  unsubscribe = null;
  writes = Promise.resolve();
}
