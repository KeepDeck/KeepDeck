import { achievementRequirement } from "../domain/usage/achievements/captions";
import {
  achievementCatalog,
  migrateCongratulated,
} from "../domain/usage/achievements/catalog";
import { createAchievementEngine } from "../domain/usage/achievements/engine";
import type { UsageEventV2 } from "../domain/usage/history/event";
import type { NotifyInput } from "./notificationCenter";
import type { UsageHistorySnapshot } from "./usageHistoryManager";

/**
 * Congratulates on newly earned achievements. Earned state is derived from
 * the ledger, so "new" is a DIFF against the persisted congratulated set —
 * which makes awards retroactive by construction: a release that ships
 * ladders the ledger already satisfies congratulates on the first launch
 * after the update, exactly like a live crossing would. Every award gets
 * its OWN notification — no summary batching (user decision).
 *
 * An app-lifetime service owned by the runtime (constructed in
 * `createAppRuntime`, disposed with it) — dependencies are injected, so
 * tests build their own instance with fakes instead of mocking modules.
 * Appends are folded into an incremental [`AchievementEngine`] — the
 * unbounded ledger is never re-sorted per turn; only a wholesale snapshot
 * replacement (a compaction rewrite) refolds from scratch.
 */

/** Bumped when the catalog's ids move under a persisted file. Version 1
 * predates the rarity recalibration; version 2 has been through it. */
const NOTIFIED_SCHEMA_VERSION = 2;

export interface AchievementNotifierDeps {
  loadNotified(): Promise<string | null>;
  saveNotified(json: string): Promise<void>;
  /** Resolves when user settings are loaded. Announcing is gated on it:
   * notify() falls back to DEFAULT prefs while settings are in flight, and
   * a delivery decision here is the one that gets PERSISTED — racing the
   * settings load could banner past a user who disabled notifications and
   * then never announce those awards again. */
  settingsReady(): Promise<void>;
  /** Returns whether a delivery channel accepted it (see
   * [`notificationCenter.notify`]). */
  notify(input: NotifyInput): boolean;
  history: {
    getSnapshot(): UsageHistorySnapshot;
    subscribe(listener: () => void): () => void;
  };
}

export function createAchievementNotifier(deps: AchievementNotifierDeps): {
  dispose(): void;
} {
  const catalog = achievementCatalog();
  let engine = createAchievementEngine();
  let processed = 0;
  /** Identity of the first folded event — the wholesale-replacement guard.
   * Length alone cannot detect a same-or-longer replacement with different
   * content; the array is append-only in production, but correctness must
   * not rest on an invariant nothing here asserts. */
  let firstFolded: UsageEventV2 | undefined;
  /** Null until the persisted baseline loads; checks wait for it. */
  let congratulated: Set<string> | null = null;
  let writes: Promise<void> = Promise.resolve();
  let disposed = false;

  const persist = (ids: ReadonlySet<string>) => {
    const json = JSON.stringify({
      version: NOTIFIED_SCHEMA_VERSION,
      notified: [...ids].sort(),
    });
    writes = writes
      .catch(() => {})
      .then(() => deps.saveNotified(json))
      // Best-effort: a failed save means at worst a repeated congratulation.
      .catch(() => {});
  };

  const check = () => {
    if (disposed || congratulated === null) return;
    const snapshot = deps.history.getSnapshot();
    if (!snapshot.ready) return;
    if (
      snapshot.events.length < processed ||
      (processed > 0 && snapshot.events[0] !== firstFolded)
    ) {
      // The array was replaced wholesale — refold from scratch.
      engine = createAchievementEngine();
      processed = 0;
      firstFolded = undefined;
    }
    for (let index = processed; index < snapshot.events.length; index += 1) {
      engine.ingest(snapshot.events[index]);
    }
    if (processed === 0 && snapshot.events.length > 0) {
      firstFolded = snapshot.events[0];
    }
    processed = snapshot.events.length;

    const earned = engine.earnedIds();
    let dirty = false;
    // Catalog order: a ladder announces lowest tier first, so the bell's
    // newest-first list tops out at the most impressive fresh award.
    for (const entry of catalog) {
      if (!earned.has(entry.id) || congratulated.has(entry.id)) continue;
      const delivered = deps.notify({
        title: `Achievement unlocked: ${entry.title}`,
        body: achievementRequirement(entry),
        icon: entry.icon,
        // The click destination is the trophy case, not Settings.
        source: { type: "stats", tab: "achievements" },
        tag: `achievement:${entry.id}`,
      });
      // An undelivered congratulation (notifications disabled or muted)
      // stays unrecorded — re-enabling announces it instead of losing it.
      if (delivered) {
        congratulated.add(entry.id);
        dirty = true;
      }
    }
    if (dirty) persist(congratulated);
  };

  const unsubscribe = deps.history.subscribe(check);
  // An unreadable baseline congratulates from scratch rather than staying
  // silent forever; a failed settings load proceeds on defaults — at that
  // point defaults ARE the app's real prefs, not a race artifact.
  const baseline = deps.loadNotified().catch(() => null);
  const settings = deps.settingsReady().catch(() => undefined);
  void Promise.all([baseline, settings]).then(([json]) => {
    if (disposed) return;
    congratulated = decode(json);
    check();
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}

/**
 * Read the congratulated set, carrying a pre-recalibration file forward.
 *
 * The version gate is doing real work, not ceremony: a moved tier's id maps
 * onto the one that replaced it, and on the spend ladder — which shifted by
 * a whole step — some old ids are ALSO live new ids. Applying the map twice
 * would walk those awards up the ladder one rung per launch, so it runs
 * exactly once, on a file that predates the change.
 */
function decode(json: string | null): Set<string> {
  if (json === null) return new Set();
  try {
    const value = JSON.parse(json) as { notified?: unknown; version?: unknown };
    if (Array.isArray(value.notified)) {
      const ids = value.notified.filter(
        (id): id is string => typeof id === "string",
      );
      const version = typeof value.version === "number" ? value.version : 1;
      return version < NOTIFIED_SCHEMA_VERSION
        ? migrateCongratulated(ids)
        : new Set(ids);
    }
  } catch {
    // fall through to the empty baseline
  }
  return new Set();
}
