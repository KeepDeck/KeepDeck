import { localDayNumber, shiftDay, type LocalDayNumber } from "./time";

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
 *
 * INSTANTS, not events. Activity has two witnesses and this function knows
 * neither: recorded spend, and a live report that has not become spend yet.
 * It used to read the ledger and behave as though that were the only
 * evidence there is, which is why the count lagged the start of work — the
 * first report of a session seeds a baseline and writes nothing, so nothing
 * reached the ledger until the first turn actually spent something.
 *
 * Who counts as a witness is NOT this function's question, and not a view's
 * either: it belongs to `createActivityWitness`, which also owns the fact
 * that a day already witnessed stays witnessed. This one is about days.
 */

export function currentStreakDays(
  activeAt: Iterable<number>,
  now: number,
): number {
  const days = new Set<LocalDayNumber>();
  for (const at of activeAt) {
    // A future instant is corrupt input, not tomorrow: a skewed clock's row
    // in the never-pruned ledger must not open a day nobody has lived yet.
    if (at > now) continue;
    days.add(localDayNumber(at));
  }
  const today = localDayNumber(now);
  const yesterday = shiftDay(today, -1);
  const anchor = days.has(today)
    ? today
    : days.has(yesterday)
      ? yesterday
      : null;
  if (anchor === null) return 0;
  let streak = 0;
  for (let day = anchor; days.has(day); day = shiftDay(day, -1)) streak += 1;
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
