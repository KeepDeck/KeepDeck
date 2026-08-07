import { describe, expect, it } from "vitest";
import { usageEvent } from "../history/event.testSupport";
import { createAchievementEngine } from "./engine";

/**
 * The metric accumulator. Most of it is covered through `usageAchievementLadders`
 * in `ladders.test.ts`, which is the right altitude for "does the gallery say
 * the right thing". What lives HERE is the one thing that view cannot see: the
 * engine folds days under TWO different calendars on purpose, and every
 * fixture spaced a flat 24h apart passes under either of them.
 */

/** Run a body in a FIXED zone, whatever the runner is in — the suite pins no
 * TZ, so a fold that differs by calendar proves nothing until one is chosen. */
function inZone(tz: string, body: () => void): void {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const at = (year: number, month: number, day: number, hour: number) =>
  new Date(year, month, day, hour, 0, 0, 0).getTime();

const fold = (instants: number[]) => {
  const engine = createAchievementEngine();
  for (const [index, occurredAt] of instants.entries()) {
    engine.ingest(
      usageEvent({
        eventId: `e-${index}`,
        occurredAt,
        tokens: { input: 1_000 },
        observation: { tokens: { input: 1_000 } },
      }),
    );
  }
  return engine;
};

describe("the calendar the longest streak is folded in", () => {
  it("counts the reader's days, not UTC buckets", () => {
    // THE guard. East of UTC a session at 01:00 local lands on the PREVIOUS
    // UTC day, so 01:00 and 12:00 on the same local day paint two adjacent
    // UTC buckets — and working every OTHER local day reads as an unbroken
    // UTC run. The UTC number was not merely late here, it was wrong.
    //
    // Twenty active days, every second day, each with two sessions:
    //   local  → 20 separate days, longest run 1
    //   UTC    → every bucket touched, longest run 40
    // Reverting `streak.add` to the UTC ordinal turns the 1 below into 40.
    inZone("Europe/Moscow", () => {
      const instants: number[] = [];
      for (let day = 1; day <= 40; day += 2) {
        instants.push(at(2026, 3, day, 1), at(2026, 3, day, 12));
      }
      expect(fold(instants).value("streakDays")).toBe(1);
    });
  });

  it("counts a run that only the reader's calendar can see", () => {
    // The same asymmetry in the other direction, so the test above cannot
    // pass by simply returning a small number. Three consecutive local days
    // whose sessions sit at 01:00 — under UTC these are three days too, but
    // they are the PREVIOUS three, and a fourth session late on the last
    // local evening joins the local run while opening a UTC gap.
    inZone("Europe/Moscow", () => {
      const instants = [
        at(2026, 3, 10, 1),
        at(2026, 3, 11, 1),
        at(2026, 3, 12, 1),
        at(2026, 3, 12, 23),
      ];
      expect(fold(instants).value("streakDays")).toBe(3);
    });
  });

  it("leaves the per-day PEAKS on the UTC bucket", () => {
    // Deliberate split, and the reason it is not a bug: a streak is "did I
    // show up today" — the reader's own calendar — while a peak is "how big
    // was the biggest day", an aggregation that must bucket identically
    // wherever the ledger is read. Two sessions on ONE local day that
    // straddle the UTC boundary are therefore one streak day and TWO peak
    // days, so the peak counts 1000 tokens rather than 2000.
    inZone("Europe/Moscow", () => {
      const engine = fold([at(2026, 3, 10, 1), at(2026, 3, 10, 12)]);
      expect(engine.value("streakDays")).toBe(1);
      expect(engine.value("dayTokens")).toBe(1_000);
      expect(engine.value("daySessions")).toBe(1);
    });
  });
});

describe("order independence", () => {
  it("reaches the same longest run whatever order the days arrive in", () => {
    // What lets the notifier fold an appended suffix instead of re-sorting
    // the unbounded ledger every turn.
    inZone("Europe/Moscow", () => {
      const days = [10, 11, 12, 14, 15].map((day) => at(2026, 3, day, 12));
      const forward = fold(days).value("streakDays");
      const shuffled = fold([days[3], days[0], days[4], days[2], days[1]]);
      expect(forward).toBe(3);
      expect(shuffled.value("streakDays")).toBe(3);
    });
  });
});
