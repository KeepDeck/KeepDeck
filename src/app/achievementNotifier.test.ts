import { describe, expect, it, vi } from "vitest";
import { RECALIBRATED_IDS } from "../domain/usage/achievements/catalog";
import {
  createAchievementNotifier,
  migrateFrom,
  type AchievementNotifierDeps,
} from "./achievementNotifier";
import type { NotifyInput } from "./notificationCenter";
import type { UsageHistorySnapshot } from "./usageHistoryManager";

import { usageEvent as event } from "../domain/usage/history/event.testSupport";


// 2M tokens + provider cost earns: First Million, Warm Afternoon,
// Hello Agent, Day One, First Dollar — five fresh awards.
const richEvents = () => [
  event({ tokens: { input: 2_000_000 }, costSource: "provider", costUsd: 15 }),
];

/** A controllable in-memory history the notifier subscribes to. */
function fakeHistory(initial: UsageHistorySnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: UsageHistorySnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeDeps(over: Partial<AchievementNotifierDeps> = {}) {
  const saved: string[] = [];
  const notify = vi.fn<(input: NotifyInput) => boolean>(() => true);
  const history = fakeHistory({ ready: true, events: [], error: null });
  const deps: AchievementNotifierDeps = {
    loadNotified: async () => null,
    saveNotified: async (json) => {
      saved.push(json);
    },
    settingsReady: async () => {},
    notify,
    history,
    ...over,
  };
  return { deps, saved, notify, history };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createAchievementNotifier", () => {
  it("congratulates retroactively on first run, one notification per award", async () => {
    const { deps, saved, notify, history } = fakeDeps();
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(5);
    const titles = notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    expect(titles).toContain("Achievement unlocked: First Million");
    expect(titles).toContain("Achievement unlocked: First Dollar");
    expect(notify.mock.calls[0][0]).toMatchObject({
      source: { type: "stats", tab: "achievements" },
    });
    for (const call of notify.mock.calls) {
      expect((call[0] as { icon?: string }).icon).toBeTruthy();
    }
    await settle();
    const persisted = JSON.parse(saved[saved.length - 1]) as {
      notified: string[];
    };
    expect(persisted.notified).toContain("tokens-1000000");
    expect(persisted.notified).toContain("spendUsd-10");
    notifier.dispose();
  });

  it("announces only awards missing from the persisted baseline", async () => {
    const { deps, notify, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 1,
          notified: [
            "tokens-1000000",
            "dayTokens-1000000",
            "sessions-1",
            "streakDays-1",
          ],
        }),
    });
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: "Achievement unlocked: First Dollar",
      body: "$10 provider-reported spend",
      tag: "achievement:spendUsd-10",
    });
    notifier.dispose();
  });

  it("stays silent when nothing new is earned", async () => {
    const { deps, saved, notify, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 1,
          notified: [
            "tokens-1000000",
            "dayTokens-1000000",
            "sessions-1",
            "streakDays-1",
            // A pre-recalibration id: decode carries it onto the tier that
            // replaced it, so this award is not congratulated twice.
            "spendUsd-1",
          ],
        }),
    });
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    notifier.dispose();
  });

  it("folds appended events incrementally and reacts to them", async () => {
    const { deps, notify, history } = fakeDeps({
      loadNotified: async () => null,
    });
    history.set({ ready: false, events: [], error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();
    expect(notify).not.toHaveBeenCalled();

    const first = event();
    history.set({ ready: true, events: [first], error: null });
    await settle();
    // A lone session earns the two day-one tiers and nothing else.
    expect(notify).toHaveBeenCalledTimes(2);
    expect(
      notify.mock.calls.map((call) => (call[0] as { title: string }).title),
    ).toEqual([
      "Achievement unlocked: Hello, Agent",
      "Achievement unlocked: Day One",
    ]);

    // Appending nine more sessions crosses First Steps — only the suffix
    // is folded in, and the earlier award is not re-announced.
    const more = Array.from({ length: 9 }, (_, index) =>
      event({
        sessionId: `s${index + 2}`,
        rootSessionId: `s${index + 2}`,
      }),
    );
    history.set({ ready: true, events: [first, ...more], error: null });
    await settle();
    const titles = notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    expect(titles).toContain("Achievement unlocked: First Steps");
    expect(titles.filter((t) => t.includes("Hello, Agent"))).toHaveLength(1);
    notifier.dispose();
  });

  it("refolds from scratch when the snapshot shrinks (compaction rewrite)", async () => {
    const { deps, notify, history } = fakeDeps();
    history.set({ ready: true, events: [event(), event()], error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();
    const before = notify.mock.calls.length;

    // Wholesale replacement with fewer events must not double-count.
    history.set({ ready: true, events: [event()], error: null });
    await settle();
    expect(notify.mock.calls.length).toBe(before); // nothing newly earned
    notifier.dispose();
  });

  it("refolds on a same-or-longer wholesale replacement, not just a shrink", async () => {
    const { deps, notify, history } = fakeDeps();
    // $9 folded — just short of First Dollar.
    history.set({
      ready: true,
      events: [event({ costSource: "provider", costUsd: 9 })],
      error: null,
    });
    const notifier = createAchievementNotifier(deps);
    await settle();
    const titles = () =>
      notify.mock.calls.map((call) => (call[0] as { title: string }).title);
    expect(titles()).not.toContain("Achievement unlocked: First Dollar");

    // Replace WHOLESALE with a longer array totaling only $2.50. A
    // length-only guard would keep the old $9 fold and add the new tail's
    // $2 → a false First Dollar; the head-identity guard refolds.
    history.set({
      ready: true,
      events: [
        event({ costSource: "provider", costUsd: 0.5 }),
        event({ costSource: "provider", costUsd: 2 }),
      ],
      error: null,
    });
    await settle();
    expect(titles()).not.toContain("Achievement unlocked: First Dollar");
    notifier.dispose();
  });

  it("keeps undelivered awards unrecorded so re-enabling announces them", async () => {
    const { deps, saved, notify, history } = fakeDeps();
    notify.mockReturnValue(false); // notifications disabled
    history.set({ ready: true, events: [event()], error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(0); // nothing persisted as congratulated

    notify.mockReturnValue(true); // user re-enables notifications
    history.set({ ready: true, events: [event(), event()], error: null });
    await settle();
    const titles = notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    expect(titles.filter((t) => t.includes("Hello, Agent")).length).toBe(2);
    await settle();
    expect(saved.length).toBeGreaterThan(0);
    notifier.dispose();
  });

  it("persists the congratulated set sorted, for stable diffs on disk", async () => {
    const { deps, saved, history } = fakeDeps();
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    const persisted = JSON.parse(saved[saved.length - 1]) as {
      notified: string[];
    };
    expect(persisted.notified).toEqual([...persisted.notified].sort());
    notifier.dispose();
  });

  it("tolerates a wrong-typed baseline: non-array resets, mixed array filters", async () => {
    // notified as a plain string → empty baseline → everything announces.
    const wrongType = fakeDeps({
      loadNotified: async () => JSON.stringify({ version: 1, notified: "oops" }),
    });
    wrongType.history.set({ ready: true, events: [event()], error: null });
    const first = createAchievementNotifier(wrongType.deps);
    await settle();
    expect(wrongType.notify).toHaveBeenCalledTimes(2);
    first.dispose();

    // Mixed-type array → the valid ids survive and stay congratulated.
    const mixed = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 1,
          notified: [42, "sessions-1", null, "streakDays-1"],
        }),
    });
    mixed.history.set({ ready: true, events: [event()], error: null });
    const second = createAchievementNotifier(mixed.deps);
    await settle();
    expect(mixed.notify).not.toHaveBeenCalled();
    second.dispose();
  });

  it("treats an unreadable baseline as empty instead of staying silent", async () => {
    const { deps, notify, history } = fakeDeps({
      loadNotified: async () => "torn{",
    });
    history.set({ ready: true, events: [event()], error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();
    expect(notify).toHaveBeenCalledTimes(2);
    notifier.dispose();
  });

  it("announces nothing until settings load — a default-prefs banner would persist", async () => {
    let resolveSettings!: () => void;
    const { deps, notify, history } = fakeDeps({
      settingsReady: () =>
        new Promise<void>((resolve) => {
          resolveSettings = resolve;
        }),
    });
    history.set({ ready: true, events: [event()], error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();
    // notify() would fall back to DEFAULT prefs here; a delivery recorded
    // against them can never be re-announced once real prefs land.
    expect(notify).not.toHaveBeenCalled();

    resolveSettings();
    await settle();
    expect(notify).toHaveBeenCalledTimes(2);
    notifier.dispose();
  });

  it("goes quiet after dispose, even if the baseline load resolves late", async () => {
    let resolveLoad!: (value: string | null) => void;
    const { deps, notify, history } = fakeDeps({
      loadNotified: () =>
        new Promise<string | null>((resolve) => {
          resolveLoad = resolve;
        }),
    });
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    notifier.dispose();
    resolveLoad(null);
    await settle();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("carrying a congratulated set across a recalibration", () => {
  /** The pair that makes a second pass destructive: on the spend ladder,
   * which shifted by a whole rung, these ids are BOTH retired keys AND live
   * new ids. If this ever stops being true the hazard is gone and these
   * tests are guarding nothing — so it is asserted, not assumed. */
  it("still has ids that are both a retired key and a live target", () => {
    const targets = new Set(RECALIBRATED_IDS.values());
    const overlap = [...RECALIBRATED_IDS.keys()].filter((id) => targets.has(id));
    expect(overlap).toEqual(["spendUsd-10", "spendUsd-100"]);
  });

  it("rewrites a file that predates the change", () => {
    expect(migrateFrom(1, ["spendUsd-1", "tokens-10000000"])).toEqual(
      new Set(["spendUsd-10", "tokens-25000000"]),
    );
  });

  it("leaves a file that has already been through it alone", () => {
    // THE gate. Without it the award below walks one rung further on every
    // launch: $10 → $100 → $500, re-congratulating as it goes and burning
    // the banners for tiers the user has not reached.
    expect(migrateFrom(2, ["spendUsd-10"])).toEqual(new Set(["spendUsd-10"]));
  });

  it("is idempotent across repeated loads of the same file", () => {
    const once = migrateFrom(1, ["spendUsd-1"]);
    const twice = migrateFrom(2, once);
    const thrice = migrateFrom(2, twice);
    expect(thrice).toEqual(new Set(["spendUsd-10"]));
  });

  it("keeps a set written by a NEWER build intact", () => {
    // A downgrade must not rewrite what it cannot understand.
    expect(migrateFrom(9, ["spendUsd-10", "future-999"])).toEqual(
      new Set(["spendUsd-10", "future-999"]),
    );
  });

  it("writes files at the newest migration's version, without a hand-kept constant", async () => {
    const { deps, saved, history } = fakeDeps();
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    const persisted = JSON.parse(saved[saved.length - 1]) as { version: number };
    // Re-reading what we just wrote must be a no-op — that is the whole
    // contract between persist() and decode().
    expect(migrateFrom(persisted.version, ["spendUsd-10"])).toEqual(
      new Set(["spendUsd-10"]),
    );
    notifier.dispose();
  });
});
