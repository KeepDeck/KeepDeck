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
    // Whatever is written carries no NEWS — the ids are the ones that came
    // in, carried across the rewrite. (That a write happens at all is the
    // version stamp, and belongs to its own case below.)
    for (const json of saved) {
      const notified = JSON.parse(json).notified as string[];
      expect(notified).toContain("streakDays-1");
      expect(notified).toContain("spendUsd-10");
    }
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
    // The version stamp still lands (the baseline file is below it), but it
    // carries NO congratulations — which is the claim.
    for (const json of saved) {
      expect(JSON.parse(json).notified).toEqual([]);
    }

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
  it("only ever revokes an id a rewrite could have written", () => {
    const kept = reconcileCongratulated(
      new Set(["spendUsd-10", "spendUsd-100", "streakDays-14", "future-999"]),
      new Set(["spendUsd-10"]),
      new Set(["spendUsd-10", "spendUsd-100"]),
    );
    // Earned: kept. Rewritable AND unearned: dropped, which is the whole
    // purpose. Everything a migration could not have written is kept whatever
    // the ledger currently says — `streakDays-14` because the metric is
    // re-derived per timezone, `future-999` because a newer build's set must
    // survive a downgrade intact.
    expect(kept).toEqual(
      new Set(["spendUsd-10", "streakDays-14", "future-999"]),
    );
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

  it("does not take back an award because a metric was re-derived", async () => {
    // THE reason the sweep is scoped to rewritten ids. `streakDays` folds in
    // the READER'S calendar and the event carries no offset, so the same
    // ledger yields a different number in a different timezone. Under the old
    // whole-set sweep, flying east deleted a badge earned months ago from
    // disk — and flying back announced it a second time as if new. A metric
    // is allowed to be re-derived; an award is not allowed to evaporate.
    //
    // The file is already at the current version, so no migration replays and
    // nothing at all is revocable — which is exactly the everyday launch.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 2,
          notified: ["streakDays-14", "spendUsd-500"],
        }),
    });
    // One day of spend: neither a 14-day streak nor $500 is supported here.
    history.set(ledger([event({ costSource: "provider", costUsd: 60 })]));
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    // There IS a write — the day-one tiers this ledger does earn — so the
    // assertions below are not passing on an empty `saved`.
    expect(saved.length).toBeGreaterThan(0);
    const persisted = JSON.parse(saved[saved.length - 1]) as {
      notified: string[];
    };
    expect(persisted.notified).toContain("streakDays-14");
    expect(persisted.notified).toContain("spendUsd-500");
    notifier.dispose();
  });

  it("stamps the version forward on a launch with nothing else to say", async () => {
    // The narrowing made the version stamp LOAD-BEARING: it is what retires
    // `rewritable`. But `persist` only fires when something is dirty, and an
    // established user's launch is dirty at nothing — so the file sat at v1
    // forever, every migration target stayed revocable on every later launch,
    // and a timezone change months after the upgrade could still take a badge
    // away through the very sweep this commit narrowed.
    const { deps, saved, notify, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({
          version: 1,
          notified: [
            "tokens-1000000",
            "dayTokens-1000000",
            "sessions-1",
            "streakDays-1",
            "spendUsd-1",
          ],
        }),
    });
    history.set(ledger(richEvents()));
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]).version).toBe(2);
    // And a file already at the version writes nothing — the stamp is a
    // one-shot, not a write on every launch.
    const settled = fakeDeps({ loadNotified: async () => saved[0] });
    settled.history.set(ledger(richEvents()));
    const second = createAchievementNotifier(settled.deps);
    await settle();
    await settle();
    expect(settled.saved).toHaveLength(0);
    notifier.dispose();
    second.dispose();
  });

  it("does not stamp a version past a repair it could not perform", async () => {
    // The mirror hole. The sweep is gated on `complete`; the stamp was not.
    // A downgrade past a usage-event schema bump publishes a ready, error-free
    // snapshot missing most of the history, so the sweep is skipped — and if
    // any unrelated award made the write happen, the file advanced to v2 and
    // the repair window shut for good.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ version: 1, notified: ["spendUsd-10"] }),
    });
    history.set({
      ready: true,
      events: [event({ costSource: "provider", costUsd: 60 })],
      error: null,
      complete: false,
    });
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    // Nothing written at all: the migrated set may not go to disk until the
    // repair that belongs with it can run.
    expect(saved).toHaveLength(0);
    notifier.dispose();
  });

  it("still repairs a rewrite on the launch that performs it", async () => {
    // What the narrowing kept. A file BELOW the migration is the one case
    // where an unearned id can have been written by this build, and it is
    // still swept — the version gate is now load-bearing, not an
    // optimisation, so this is the guard that says so.
    const { deps, saved, history } = fakeDeps({
      loadNotified: async () =>
        JSON.stringify({ version: 1, notified: ["spendUsd-10"] }),
    });
    history.set(ledger([event({ costSource: "provider", costUsd: 60 })]));
    const notifier = createAchievementNotifier(deps);
    await settle();
    await settle();
    const persisted = JSON.parse(saved[saved.length - 1]) as {
      notified: string[];
    };
    // spendUsd-10 rewrites to spendUsd-100, which $60 does not support.
    expect(persisted.notified).not.toContain("spendUsd-100");
    notifier.dispose();
  });
});
