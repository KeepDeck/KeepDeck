import { describe, expect, it } from "vitest";
import { usageEvent } from "../domain/usage/history/event.testSupport";
import { ledgerOf } from "../domain/usage/history/ledger.testSupport";
import type { UsageRow } from "../domain/usage/history/event";
import type { NotifyInput } from "./notificationCenter";
import type { UsageHistorySnapshot } from "./usageHistoryManager";
import { createWeeklyDigestNotifier } from "./weeklyDigestNotifier";
import { inZoneAsync } from "../domain/usage/time.testSupport";

const at = (iso: string) => new Date(iso).getTime();
/** A Wednesday; last week ran Nov 2 – Nov 8. */
const WEDNESDAY = Date.parse("2026-11-11T12:00:00Z");
const lastWeekRow = (over: Parameters<typeof usageEvent>[0] = {}) =>
  usageEvent({ occurredAt: Date.parse("2026-11-04T12:00:00Z"), costUsd: 5, ...over });

function rig({ stored = null as string | null, rows = [lastWeekRow()] as UsageRow[], delivered = true } = {}) {
  let snapshot: UsageHistorySnapshot = {
    ready: true,
    complete: true,
    ledger: ledgerOf(rows),
    error: null,
    perModelSince: null,
  };
  let listener = () => {};
  let tick = () => {};
  let now = WEDNESDAY;
  const notified: NotifyInput[] = [];
  const saved: string[] = [];
  const notifier = createWeeklyDigestNotifier({
    loadDigest: () => Promise.resolve(stored),
    saveDigest: (json) => {
      saved.push(json);
      return Promise.resolve();
    },
    settingsReady: () => Promise.resolve(),
    notify: (input) => {
      notified.push(input);
      return delivered;
    },
    history: {
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        listener = next;
        return () => {};
      },
    },
    now: () => now,
    every: (_ms, next) => {
      tick = next;
      return () => {};
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    notifier,
    notified,
    saved,
    settle,
    change(next: Partial<UsageHistorySnapshot>) {
      snapshot = { ...snapshot, ...next };
      listener();
    },
    advance(to: number) {
      now = to;
      tick();
    },
  };
}

describe("the weekly digest", () => {
  it("tells last week once, opening Weekly on it, and remembers that it did", async () => {
    const { notified, saved, settle, change } = rig();
    await settle();
    expect(notified).toHaveLength(1);
    expect(notified[0]?.source).toMatchObject({ type: "stats", tab: "weekly" });
    expect(notified[0]?.title).toMatch(/^Your week in KeepDeck · /);
    await settle();
    expect(saved).toHaveLength(1);
    // More usage this week tells nothing new about last week.
    change({ ledger: ledgerOf([lastWeekRow(), usageEvent({ occurredAt: WEDNESDAY - 1, costUsd: 1 })]) });
    expect(notified).toHaveLength(1);
  });

  it("does not repeat a week a previous launch already told", async () => {
    const first = rig();
    await first.settle();
    await first.settle();
    const told = first.saved[0] ?? null;
    const second = rig({ stored: told });
    await second.settle();
    expect(second.notified).toEqual([]);
  });

  it("tells the next week when it ends, on the hourly tick without any new usage", async () => {
    const { notified, settle, advance } = rig({
      rows: [lastWeekRow(), usageEvent({ occurredAt: WEDNESDAY - 1, costUsd: 2 })],
    });
    await settle();
    advance(at("2026-11-16T09:00:00Z"));
    expect(notified).toHaveLength(2);
  });

  it("passes a week with no usage over in silence, and waits for a whole history", async () => {
    const quiet = rig({ rows: [] });
    await quiet.settle();
    expect(quiet.notified).toEqual([]);
    await quiet.settle();
    expect(quiet.saved).toHaveLength(1);

    const partial = rig();
    partial.change({ complete: false });
    await partial.settle();
    // The load lands on an incomplete snapshot: nothing until it completes.
    expect(partial.notified).toEqual([]);
    partial.change({ complete: true });
    expect(partial.notified).toHaveLength(1);
  });

  it("keeps an undelivered digest due — turning notifications back on tells it", async () => {
    const { notified, saved, settle, change } = rig({ delivered: false });
    await settle();
    expect(notified).toHaveLength(1);
    await settle();
    expect(saved).toEqual([]);
    change({});
    expect(notified).toHaveLength(2);
  });

  it("does not tell the same week again after the reader moves west", async () => {
    const first = rig();
    await first.settle();
    await first.settle();
    const told = first.saved[0] ?? null;
    await inZoneAsync("America/Los_Angeles", async () => {
      const west = rig({ stored: told });
      await west.settle();
      expect(west.notified).toEqual([]);
    });
  });

  it("reads an unreadable document as none — at worst one repeat", async () => {
    const { notified, settle } = rig({ stored: "{not json" });
    await settle();
    expect(notified).toHaveLength(1);
  });

  it("stops listening when disposed", async () => {
    const { notifier, notified, settle, change } = rig({ delivered: false });
    await settle();
    notifier.dispose();
    change({});
    expect(notified).toHaveLength(1);
  });
});

describe("the digest's click", () => {
  it("names the week it reports", async () => {
    const { notified, settle } = rig();
    await settle();
    const source = notified[0]?.source;
    // Last week's Monday, Nov 2, as a day ordinal — a calendar date.
    expect(source?.type === "stats" ? source.week : undefined).toBe(Date.UTC(2026, 10, 2) / 86_400_000);
  });
});
