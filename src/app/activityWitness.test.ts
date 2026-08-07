import { describe, expect, it } from "vitest";
import type { PaneUsage } from "@keepdeck/plugin-api";
import type { UsageEventV2 } from "../domain/usage/history/event";
import {
  TEST_NOW,
  usageEvent,
} from "../domain/usage/history/event.testSupport";
import { currentStreakDays } from "../domain/usage/streak";
import { createActivityWitness } from "./activityWitness";
import type { UsageHistorySnapshot } from "./usageHistoryManager";
import type { UsageSnapshot } from "./usageManager";

/** The witness owns the ONE question "on which days was the reader here",
 * over two stores with different lifetimes. Every case below is stated as a
 * streak, because that is the only thing the answer is for. */

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1_000;

const ledger = (events: UsageEventV2[]): UsageHistorySnapshot => ({
  ready: true,
  events,
  error: null,
  complete: true,
});

const spend = (occurredAt: number, eventId = `e-${occurredAt}`) =>
  usageEvent({ eventId, occurredAt });

const pane = (reportedAt: number): PaneUsage => ({
  agent: "claude",
  reportedAt,
});

function fakes(initial: UsageEventV2[] = []) {
  let historySnapshot = ledger(initial);
  let usageSnapshot: UsageSnapshot = {
    accounts: new Map(),
    panes: new Map(),
  };
  const historyListeners = new Set<() => void>();
  const usageListeners = new Set<() => void>();
  return {
    history: {
      getSnapshot: () => historySnapshot,
      subscribe: (listener: () => void) => {
        historyListeners.add(listener);
        return () => historyListeners.delete(listener);
      },
    },
    usage: {
      getSnapshot: () => usageSnapshot,
      subscribe: (listener: () => void) => {
        usageListeners.add(listener);
        return () => usageListeners.delete(listener);
      },
    },
    appendEvents(events: UsageEventV2[]) {
      historySnapshot = ledger([...historySnapshot.events, ...events]);
      for (const listener of [...historyListeners]) listener();
    },
    replaceLedger(events: UsageEventV2[]) {
      historySnapshot = ledger(events);
      for (const listener of [...historyListeners]) listener();
    },
    setPanes(panes: [string, PaneUsage][]) {
      usageSnapshot = { accounts: new Map(), panes: new Map(panes) };
      for (const listener of [...usageListeners]) listener();
    },
  };
}

describe("what the witness accepts as evidence", () => {
  it("counts today from a live report, before it has become recorded spend", () => {
    // THE lag this exists for. The first report of a session seeds a
    // baseline and appends nothing, and codex's opening `turn_context`
    // carries no tokens at all — so the ledger stays silent for a whole
    // first turn while the user is plainly working.
    const store = fakes([spend(NOW - DAY), spend(NOW - 2 * DAY)]);
    const witness = createActivityWitness(store);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(2);

    store.setPanes([["pane-1", pane(NOW - 60_000)]]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(3);
    witness.dispose();
  });

  it("does not let a stale report claim today", () => {
    // A pane whose last word was yesterday proves yesterday, not now.
    const store = fakes([spend(NOW - DAY)]);
    const witness = createActivityWitness(store);
    store.setPanes([["pane-1", pane(NOW - DAY)]]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(1);
    witness.dispose();
  });

  it("reads what both stores already hold at construction", () => {
    // Built in the composition root, not in `start()` — a witness that began
    // empty would miss every day its stores published before it existed.
    const store = fakes([spend(NOW - DAY)]);
    store.setPanes([["pane-1", pane(NOW)]]);
    const witness = createActivityWitness(store);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(2);
    witness.dispose();
  });

  it("ignores an instant that is not a real one", () => {
    const store = fakes([spend(NOW)]);
    const witness = createActivityWitness(store);
    store.setPanes([
      ["a", pane(0)],
      ["b", pane(Number.NaN)],
      ["c", pane(-1)],
    ]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(1);
    witness.dispose();
  });
});

describe("a day that has been witnessed stays witnessed", () => {
  it("keeps today after the reporting pane is cleared", () => {
    // THE regression. `usage.panes` is emptied by `clearPane` on a session
    // generation change (`/clear`, `/new`), by a pane restart and by a
    // close. Reading it live made the chip a function of pane membership:
    // it counted DOWN, in front of the user, with nothing they did undone.
    const store = fakes([spend(NOW - DAY), spend(NOW - 2 * DAY)]);
    const witness = createActivityWitness(store);
    store.setPanes([["pane-1", pane(NOW - 60_000)]]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(3);

    store.setPanes([]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(3);
    witness.dispose();
  });

  it("survives a compaction that rewrites the ledger wholesale", () => {
    // A compaction replaces the array; the days it drops are torn and
    // duplicate LINES, never a day the reader actually had. The live half
    // is not in that file at all and must not be swept away with it.
    const store = fakes([spend(NOW - DAY, "dup"), spend(NOW - DAY, "dup")]);
    const witness = createActivityWitness(store);
    store.setPanes([["pane-1", pane(NOW)]]);
    store.setPanes([]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(2);

    store.replaceLedger([spend(NOW - DAY, "kept")]);
    expect(currentStreakDays(witness.getSnapshot().activeAt, NOW)).toBe(2);
    witness.dispose();
  });
});

describe("what the snapshot costs to read", () => {
  it("keeps one instant per day, not one per event", () => {
    // The array feeds a memo in the chip. Holding every instant would make
    // that memo rescan the never-pruned ledger — 69k events and counting —
    // and the identity churn would do it on every bridge report.
    const store = fakes(
      Array.from({ length: 40 }, (_, index) =>
        spend(NOW - 3 * DAY + index * 60_000, `burst-${index}`),
      ),
    );
    const witness = createActivityWitness(store);
    expect(witness.getSnapshot().activeAt).toHaveLength(1);
    witness.dispose();
  });

  it("holds the array's identity across a report on a day it already has", () => {
    const store = fakes([spend(NOW)]);
    const witness = createActivityWitness(store);
    const before = witness.getSnapshot().activeAt;
    store.setPanes([["pane-1", pane(NOW + 1_000)]]);
    const after = witness.getSnapshot();
    expect(after.activeAt).toBe(before);
    // The clock floor still moves, which is what keeps a report that outran
    // the 30 s tick from being dropped by the streak's own `at > now` guard.
    expect(after.latestAt).toBe(NOW + 1_000);
    witness.dispose();
  });

  it("stops answering its stores once disposed", () => {
    const store = fakes([spend(NOW)]);
    const witness = createActivityWitness(store);
    witness.dispose();
    store.appendEvents([spend(NOW - DAY, "late")]);
    expect(witness.getSnapshot().activeAt).toHaveLength(1);
  });
});
