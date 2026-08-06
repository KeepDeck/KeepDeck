import type { UsageEventV2 } from "./history/event";
import { localDayNumber } from "./time";

/**
 * The CURRENT streak — consecutive active days ending now, in the READER'S
 * calendar. Distinct from the achievements' longest-ever streak: this one is
 * alive. The Duolingo rule applies: a streak survives an inactive today (the
 * day is not over), but an inactive yesterday means it is broken and the
 * count starts over.
 *
 * Local days, not UTC ones. A streak answers "did I show up today", and
 * today is the reader's own — bucketing it in UTC meant the count turned
 * over at 03:00 for a UTC+3 reader, so a session after midnight extended
 * yesterday and left the day it happened on looking empty.
 */

export function currentStreakDays(
  events: readonly UsageEventV2[],
  now: number,
): number {
  const days = new Set<number>();
  for (const event of events) {
    if (event.occurredAt > now) continue;
    days.add(localDayNumber(event.occurredAt));
  }
  const today = localDayNumber(now);
  const anchor = days.has(today) ? today : days.has(today - 1) ? today - 1 : null;
  if (anchor === null) return 0;
  let streak = 0;
  for (let day = anchor; days.has(day); day -= 1) streak += 1;
  return streak;
}

/** How hot the streak burns — each tier unlocks a louder look. */
export type StreakHeat = "none" | "ember" | "flame" | "blaze" | "inferno";

export function streakHeat(days: number): StreakHeat {
  if (days >= 100) return "inferno";
  if (days >= 30) return "blaze";
  if (days >= 7) return "flame";
  if (days >= 3) return "ember";
  return "none";
}
