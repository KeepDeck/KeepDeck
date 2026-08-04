import { describe, expect, it, vi } from "vitest";
import {
  createAchievementNotifier,
  migrateFrom,
  reconcileCongratulated,
  type AchievementNotifierDeps,
} from "./achievementNotifier";
import type { NotifyInput } from "./notificationCenter";
import type { UsageHistorySnapshot } from "./usageHistoryManager";

import type { UsageEventV2 } from "../domain/usage/history/event";
import { usageEvent as event } from "../domain/usage/history/event.testSupport";


// 2M tokens + provider cost earns: First Million, Warm Afternoon,
// Hello Agent, Day One, First Tenner — five fresh awards.
const richEvents = () => [
  event({ tokens: { input: 2_000_000 }, costSource: "provider", costUsd: 15 }),
];

/** A ready snapshot of the WHOLE ledger — what a healthy load publishes, and
 * the only state in which the notifier is allowed to delete anything. */
const ledger = (events: UsageEventV2[]): UsageHistorySnapshot => ({
  ready: true,
  events,
  error: null,
  complete: true,
});

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
  const history = fakeHistory(ledger([]));
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
    history.set(ledger(richEvents()));
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(5);
    const titles = notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    expect(titles).toContain("Achievement unlocked: First Million");
    expect(titles).toContain("Achievement unlocked: First Tenner");
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
    history.set(ledger(richEvents()));
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: "Achievement unlocked: First Tenner",
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
    history.set(ledger(richEvents()));
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
    history.set({ ready: false, events: [], error: null, complete: false });
    const notifier = createAchievementNotifier(deps);
    await settle();
    expect(notify).not.toHaveBeenCalled();

    const first = event();
    history.set(ledger([first]));
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
    history.set(ledger([first, ...more]));
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
    history.set(ledger([event(), event()]));
    const notifier = createAchievementNotifier(deps);
    await settle();
    const before = notify.mock.calls.length;

    // Wholesale replacement with fewer events must not double-count.
    history.set(ledger([event()]));
    await settle();
    expect(notify.mock.calls.length).toBe(before); // nothing newly earned
    notifier.dispose();
  });

  it("refolds on a same-or-longer wholesale replacement, not just a shrink", async () => {
    const { deps, notify, history } = fakeDeps();
    // $9 folded — just short of First Tenner.
    history.set(ledger([event({ costSource: "provider", costUsd: 9 })]));
    const notifier = createAchievementNotifier(deps);
    await settle();
    const titles = () =>
      notify.mock.calls.map((call) => (call[0] as { title: string }).title);
    expect(titles()).not.toContain("Achievement unlocked: First Tenner");

    // Replace WHOLESALE with a longer array totaling only $2.50. A
    // length-only guard would keep the old $9 fold and add the new tail's
    // $2 → a false First Tenner; the head-identity guard refolds.
    history.set(
      ledger([
        event({ costSource: "provider", costUsd: 0.5 }),
        event({ costSource: "provider", costUsd: 2 }),
      ]),
    );
    await settle();
    expect(titles()).not.toContain("Achievement unlocked: First Tenner");
    notifier.dispose();
  });

  it("keeps undelivered awards unrecorded so re-enabling announces them", async () => {
    const { deps, saved, notify, history } = fakeDeps();
    notify.mockReturnValue(false); // notifications disabled
    history.set(ledger([event()]));
    const notifier = createAchievementNotifier(deps);
    await settle();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(0); // nothing persisted as congratulated

    notify.mockReturnValue(true); // user re-enables notifications
    history.set(ledger([event(), event()]));
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
    history.set(ledger(richEvents()));
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
    wrongType.history.set(ledger([event()]));
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
    mixed.history.set(ledger([event()]));
    const second = createAchievementNotifier(mixed.deps);
    await settle();
    expect(mixed.notify).not.toHaveBeenCalled();
    second.dispose();
  });

  it("treats an unreadable baseline as empty instead of staying silent", async () => {
    const { deps, notify, history } = fakeDeps({
      loadNotified: async () => "torn{",
    });
    history.set(ledger([event()]));
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
    history.set(ledger([event()]));
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
    history.set(ledger(richEvents()));
    const notifier = createAchievementNotifier(deps);
    notifier.dispose();
    resolveLoad(null);
    await settle();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("naming an award", () => {
  it("gives a re-earned top the same name the gallery shows", async () => {
    // The gallery said "Token Tycoon III" while the banner said plain
    // "Token Tycoon" for all three winnings: one award, two names.
    const { deps, notify, history } = fakeDeps();
    history.set(ledger([event({ tokens: { input: 2.5e10 } })]));
    const notifier = createAchievementNotifier(deps);
    await settle();
    const titles = notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    expect(titles).toContain("Achievement unlocked: Token Tycoon");
    expect(titles).toContain("Achievement unlocked: Token Tycoon II");
    notifier.dispose();
  });
});

describe("carrying a congratulated set across a recalibration", () => {
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
    history.set(ledger(richEvents()));
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

  it("never lowers the version a newer build stamped", async () => {
    // The hole the version list alone could not close: this build reads a
    // v9 file correctly, then writes its own 2 over it — and the v9 build,
    // on the way back up, replays every migration between. One round trip
    // through an older build walked spendUsd-10 → 100 → 500.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ version: 9, notified: ["future-999"] }),
    });
    history.set(ledger(richEvents()));
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    const persisted = JSON.parse(saved[saved.length - 1]) as { version: number };
    expect(persisted.version).toBe(9);
    notifier.dispose();
  });

  it("reads a file with no usable version as the oldest one", async () => {
    // The only writer that ever omitted the field predates versions
    // entirely, so its ids are pre-recalibration and must be rewritten.
    // Replaying is the safe direction now that the ledger sweep corrects it.
    const { deps, notify, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ notified: ["spendUsd-1", "tokens-1000000"] }),
    });
    history.set(ledger(richEvents()));
    const notifier = createAchievementNotifier(deps);
    await settle();
    const titles = notify.mock.calls.map(
      (call) => (call[0] as { title: string }).title,
    );
    // spendUsd-1 carried onto the tier that replaced it: not re-announced.
    expect(titles).not.toContain("Achievement unlocked: First Tenner");
    expect(titles).not.toContain("Achievement unlocked: First Million");
    notifier.dispose();
  });
});

describe("reconciling a congratulated set against the ledger", () => {
  it("keeps what the ledger supports and what it cannot place", () => {
    const kept = reconcileCongratulated(
      new Set(["spendUsd-10", "spendUsd-100", "future-999"]),
      new Set(["spendUsd-10"]),
      new Set(["spendUsd-10", "spendUsd-100"]),
    );
    // Earned: kept. Known but unearned: dropped. Unknown: kept, because a
    // newer build's set must survive a downgrade intact.
    expect(kept).toEqual(new Set(["spendUsd-10", "future-999"]));
  });

  it("gives back the banner a rewrite spent in advance", async () => {
    // $60 of spend. The old ladder congratulated its $1 and $10 tiers; the
    // rewrite carries both onto the tiers that replaced them, and the new
    // Coffee Money sits at $100 — which this user has NOT reached. Left
    // standing, that id would be skipped forever on the day they cross it.
    const upgrade = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ version: 1, notified: ["spendUsd-1", "spendUsd-10"] }),
    });
    upgrade.history.set(ledger([event({ costSource: "provider", costUsd: 60 })]));
    const first = createAchievementNotifier(upgrade.deps);
    await settle();
    await settle();
    const carried = upgrade.saved[upgrade.saved.length - 1];
    expect(JSON.parse(carried).notified).not.toContain("spendUsd-100");
    first.dispose();

    // The SAME file, a hundred dollars later. Reading back what the upgrade
    // actually wrote is the point: a set that still held the unearned id
    // would swallow this banner instead.
    const crossing = fakeDeps({ loadNotified: async () => carried });
    crossing.history.set(
      ledger([event({ costSource: "provider", costUsd: 120 })]),
    );
    const second = createAchievementNotifier(crossing.deps);
    await settle();
    expect(
      crossing.notify.mock.calls.map(
        (call) => (call[0] as { title: string }).title,
      ),
    ).toContain("Achievement unlocked: Coffee Money");
    second.dispose();
  });

  it("does not sweep against a ledger that failed to load", async () => {
    // The load rejects — a permission error, a bad mount — and the manager
    // publishes a READY snapshot with an empty array. Sweeping there reads
    // "this user has earned nothing" off a ledger nobody could open, and
    // writes it: every award re-announces on the next healthy launch.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 2,
          notified: ["tokens-1000000", "spendUsd-10"],
        }),
    });
    history.set({ ready: true, events: [], error: "EACCES", complete: false });
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    expect(saved).toHaveLength(0);
    notifier.dispose();
  });

  it("does not sweep against a ledger this build can only half read", async () => {
    // A downgrade past a usage-event schema bump: the newer build's lines
    // stay on disk but never reach the snapshot, so it is ready, error-free
    // and missing most of the user's history. The congratulated ids are ones
    // this build knows perfectly well — `known` cannot tell the difference.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 2,
          notified: ["tokens-1000000", "tokens-25000000", "spendUsd-100"],
        }),
    });
    history.set({
      ready: true,
      // The remnant this build could read: nowhere near 25M tokens or $100.
      events: [event({ tokens: { input: 1_100_000 }, costSource: "provider", costUsd: 11 })],
      error: null,
      complete: false,
    });
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    // The remnant still earns the day-one tiers, so there IS a write — an
    // empty `saved` would make the loop below prove nothing.
    expect(saved.length).toBeGreaterThan(0);
    for (const json of saved) {
      const notified = JSON.parse(json).notified as string[];
      expect(notified).toContain("tokens-25000000");
      expect(notified).toContain("spendUsd-100");
    }
    notifier.dispose();
  });

  it("repairs a file an earlier build already damaged", async () => {
    // The sweep is not gated on "a migration just ran", so a set poisoned
    // before this fix shipped heals on the next launch instead of staying
    // broken for the life of the install.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ version: 2, notified: ["spendUsd-10", "spendUsd-500"] }),
    });
    history.set(ledger([event({ costSource: "provider", costUsd: 60 })]));
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    const persisted = JSON.parse(saved[saved.length - 1]) as {
      notified: string[];
    };
    expect(persisted.notified).toContain("spendUsd-10");
    expect(persisted.notified).not.toContain("spendUsd-500");
    notifier.dispose();
  });
});
