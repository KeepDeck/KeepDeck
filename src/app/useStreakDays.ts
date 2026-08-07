import { useMemo, useSyncExternalStore } from "react";
import { currentStreakDays } from "../domain/usage/streak";
import { useWallClock } from "../ui/useWallClock";
import { useAppRuntime } from "./runtimeContext";

/**
 * The live streak, in days — the whole question behind the chip, in one
 * number.
 *
 * The composition used to sit in `StreakBadge`: the view read both stores and
 * decided that a day is proven by a recorded spend OR a live report. That is
 * a business predicate, not rendering — a `keepdeck streak` command would
 * need exactly the same rule — so the rule moved to
 * [`createActivityWitness`] and the wiring moved here, leaving the chip to
 * draw a number.
 *
 * The clock is floored on the newest witness of EITHER kind. Flooring it on
 * the ledger alone (which is what the chip did) left the new live witness
 * subject to the very lag the floor exists to remove: `currentStreakDays`
 * drops any instant past `now`, so a report landing seconds after a 30 s tick
 * was thrown away until the next one — at a local midnight, that is the chip
 * still showing yesterday while the user works.
 */
export function useStreakDays(): number {
  const { activityWitness } = useAppRuntime();
  const witness = useSyncExternalStore(
    activityWitness.subscribe,
    activityWitness.getSnapshot,
  );
  const now = useWallClock(witness.latestAt);
  // `activeAt` holds one instant per active day, so this walks a handful of
  // entries per tick — not the whole ledger, and not once per report.
  return useMemo(
    () => currentStreakDays(witness.activeAt, now),
    [witness.activeAt, now],
  );
}
