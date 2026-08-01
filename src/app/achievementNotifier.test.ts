import { describe, expect, it, vi } from "vitest";
import {
  createAchievementNotifier,
  type AchievementNotifierDeps,
} from "./achievementNotifier";
import type { NotifyInput } from "./notificationCenter";
import type { UsageHistorySnapshot } from "./usageHistoryManager";

import { usageEvent as event } from "../domain/usage/history.testSupport";


// 2M tokens + provider cost earns: First Million, Warm Afternoon,
// Hello Agent, First Dollar — four fresh awards.
const richEvents = () => [
  event({ tokens: { input: 2_000_000 }, costSource: "provider", costUsd: 1.5 }),
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

    expect(notify).toHaveBeenCalledTimes(4);
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
    expect(persisted.notified).toContain("spendUsd-1");
    notifier.dispose();
  });

  it("announces only awards missing from the persisted baseline", async () => {
    const { deps, notify, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 1,
          notified: ["tokens-1000000", "dayTokens-1000000", "sessions-1"],
        }),
    });
    history.set({ ready: true, events: richEvents(), error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: "Achievement unlocked: First Dollar",
      body: "$1 provider-reported spend",
      tag: "achievement:spendUsd-1",
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
    // A lone session earns exactly "Hello, Agent".
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: "Achievement unlocked: Hello, Agent",
    });

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

  it("keeps undelivered awards unrecorded so re-enabling announces them", async () => {
    const { deps, saved, notify, history } = fakeDeps();
    notify.mockReturnValue(false); // notifications disabled
    history.set({ ready: true, events: [event()], error: null });
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
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
    expect(wrongType.notify).toHaveBeenCalledTimes(1);
    first.dispose();

    // Mixed-type array → the valid id survives and stays congratulated.
    const mixed = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ version: 1, notified: [42, "sessions-1", null] }),
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
    expect(notify).toHaveBeenCalledTimes(1);
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
