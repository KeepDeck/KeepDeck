import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowExhaustionNotifier,
  type WindowExhaustionNotifierDeps,
} from "./windowExhaustionNotifier";
import type { NotifyInput } from "./notificationCenter";
import type { WindowReportsSnapshot } from "./windowReportJournal";
import {
  accountWindowKeys,
  type WindowReport,
} from "../domain/usage/reportJournal";
import type { AccountUsage, UsageWindow } from "../domain/usage";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const MIN = 60_000;

const FIVE_H: UsageWindow = {
  usedPct: 88,
  resetsAt: NOW + 155 * MIN,
  windowMinutes: 300,
};

const ACCOUNTS = new Map<string, AccountUsage>([
  [
    "claude",
    {
      kind: "reported",
      windows: [FIVE_H],
      reportedAt: NOW - MIN,
      sourcePaneId: "p",
    },
  ],
]);

const KEY = accountWindowKeys("claude", [FIVE_H]).get(FIVE_H)!.key;

/** A steady ramp at `pctPerMin`, newest report at NOW: 12% headroom left,
 * so pace 1 → critical (~12m out), pace 0.2 → warn (out in exactly 60m,
 * one minute shy of the critical hour). */
const series = (pctPerMin: number): WindowReport[] =>
  Array.from({ length: 5 }, (_, index) => {
    const minutesAgo = (4 - index) * 10;
    return {
      agent: "claude",
      windowMinutes: 300,
      usedPct: 88 - pctPerMin * minutesAgo,
      reportedAt: NOW - minutesAgo * MIN,
      resetsAt: FIVE_H.resetsAt,
    };
  });

const snapshotOf = (reports: WindowReport[]): WindowReportsSnapshot => ({
  ready: true,
  byKey: new Map([[KEY, reports]]),
});

function fakeJournal(initial: WindowReportsSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: WindowReportsSnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeDeps(over: Partial<WindowExhaustionNotifierDeps> = {}) {
  const notify = vi.fn<(input: NotifyInput) => boolean>(() => true);
  const journal = fakeJournal({ ready: false, byKey: new Map() });
  const deps: WindowExhaustionNotifierDeps = {
    settingsReady: async () => {},
    notify,
    journal,
    usage: { getSnapshot: () => ({ accounts: ACCOUNTS }) },
    now: () => NOW,
    ...over,
  };
  return { deps, notify, journal };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createWindowExhaustionNotifier", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a critical window once, with the popover's phrasing", async () => {
    const { deps, notify, journal } = fakeDeps();
    journal.set(snapshotOf(series(1)));
    const notifier = createWindowExhaustionNotifier(deps);
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: "claude 5h window runs out in ~12m",
      body: "resets in 2h 35m",
      icon: "⏳",
      severity: "warning",
      source: { type: "stats", tab: "providers" },
      tag: `exhaustion:${KEY}`,
    });
    journal.set(snapshotOf(series(1))); // same condition — an edge, not a level
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });

  it("waits for settings before its first fold", async () => {
    let releaseSettings = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const { deps, notify, journal } = fakeDeps({ settingsReady: () => gate });
    journal.set(snapshotOf(series(1)));
    const notifier = createWindowExhaustionNotifier(deps);
    await settle();
    expect(notify).not.toHaveBeenCalled();
    releaseSettings();
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });

  it("stays silent while the journal is not ready", async () => {
    const { deps, notify, journal } = fakeDeps();
    const notifier = createWindowExhaustionNotifier(deps);
    await settle();
    expect(notify).not.toHaveBeenCalled();
    journal.set(snapshotOf(series(1)));
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });

  it("catches a time-driven edge on the minute tick", async () => {
    vi.useFakeTimers();
    let clock = NOW;
    const { deps, notify, journal } = fakeDeps({ now: () => clock });
    journal.set(snapshotOf(series(0.2))); // out in 60m — warn, one minute shy
    const notifier = createWindowExhaustionNotifier(deps);
    await vi.advanceTimersByTimeAsync(0); // settle the settings gate
    expect(notify).not.toHaveBeenCalled();
    clock = NOW + MIN; // out in 59m now — inside the critical hour
    await vi.advanceTimersByTimeAsync(MIN);
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });

  it("retries an undelivered alarm until a channel accepts it", async () => {
    const { deps, notify, journal } = fakeDeps();
    notify.mockReturnValue(false);
    journal.set(snapshotOf(series(1)));
    const notifier = createWindowExhaustionNotifier(deps);
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    journal.set(snapshotOf(series(1))); // still undelivered — retry
    expect(notify).toHaveBeenCalledTimes(2);
    notify.mockReturnValue(true);
    journal.set(snapshotOf(series(1))); // delivered — armed at last
    expect(notify).toHaveBeenCalledTimes(3);
    journal.set(snapshotOf(series(1)));
    expect(notify).toHaveBeenCalledTimes(3);
    notifier.dispose();
  });

  it("folds nothing after dispose", async () => {
    const { deps, notify, journal } = fakeDeps();
    const notifier = createWindowExhaustionNotifier(deps);
    await settle();
    notifier.dispose();
    journal.set(snapshotOf(series(1)));
    expect(notify).not.toHaveBeenCalled();
  });
});
