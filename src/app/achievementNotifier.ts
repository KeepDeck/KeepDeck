import {
  achievementDisplayTitle,
  achievementRequirement,
} from "../domain/usage/achievements/captions";
import {
  achievementCatalog,
  knownAchievementIds,
  RECALIBRATED_IDS_V2,
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

/**
 * Every id rewrite the persisted file has ever needed, oldest first. The
 * FORMAT's owner keeps the order and the version numbers; the catalog keeps
 * the id pairs, which are catalog knowledge.
 *
 * A later recalibration appends `{ to: 3, ids: … }` here and nothing else
 * changes — see [`migrateFrom`] for why replaying a map twice is destructive.
 */
const NOTIFIED_MIGRATIONS: readonly { to: number; ids: ReadonlyMap<string, string> }[] =
  [{ to: 2, ids: RECALIBRATED_IDS_V2 }].sort((left, right) => left.to - right.to);

/** DERIVED, never hand-kept: the version a file is written at is simply the
 * newest migration it has been through. A constant maintained beside the
 * list is a constant someone forgets to bump, and forgetting means every
 * moved tier congratulates all over again.
 *
 * Sorting above is what makes the tail the newest — and what makes replay
 * order right regardless of where an entry was typed. An out-of-order append
 * would otherwise stamp files below a migration they never ran, replaying it
 * on every launch for good. */
const NOTIFIED_SCHEMA_VERSION =
  NOTIFIED_MIGRATIONS[NOTIFIED_MIGRATIONS.length - 1]?.to ?? 1;

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
  const known = knownAchievementIds();
  let engine = createAchievementEngine();
  let processed = 0;
  /** Identity of the first folded event — the wholesale-replacement guard.
   * Length alone cannot detect a same-or-longer replacement with different
   * content; the array is append-only in production, but correctness must
   * not rest on an invariant nothing here asserts. */
  let firstFolded: UsageEventV2 | undefined;
  /** Null until the persisted baseline loads; checks wait for it. */
  let congratulated: Set<string> | null = null;
  /** The version the file was READ at, so a write never lowers it. */
  let fileVersion = 0;
  /** The ledger sweep below runs once, on the first ready snapshot. */
  let reconciled = false;
  let writes: Promise<void> = Promise.resolve();
  let disposed = false;

  const persist = (ids: ReadonlySet<string>) => {
    const json = JSON.stringify({
      // NEVER the bare constant. A file written by a newer build carries a
      // higher version, and stamping ours over it tells that build its
      // migrations never ran — so the next upgrade replays them against a set
      // that already went through, walking every award that is both a retired
      // id and a live one another rung up its ladder.
      version: Math.max(fileVersion, NOTIFIED_SCHEMA_VERSION),
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
    // Only against the WHOLE ledger. `ready` means the load finished, not
    // that it could read everything: a failed load publishes a ready, EMPTY
    // snapshot, and a downgrade past a usage-event schema bump publishes a
    // ready one missing every line the newer build wrote. Sweeping either
    // would read "the user has never done this" off a ledger that simply
    // cannot see what they did — and then write that down.
    if (!reconciled && snapshot.complete) {
      reconciled = true;
      const kept = reconcileCongratulated(congratulated, earned, known);
      if (kept.size !== congratulated.size) {
        congratulated = kept;
        dirty = true;
      }
    }
    // Catalog order: a ladder announces lowest tier first, so the bell's
    // newest-first list tops out at the most impressive fresh award.
    for (const entry of catalog) {
      if (!earned.has(entry.id) || congratulated.has(entry.id)) continue;
      const delivered = deps.notify({
        title: `Achievement unlocked: ${achievementDisplayTitle(entry)}`,
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
    const file = decode(json);
    congratulated = file.notified;
    fileVersion = file.version;
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
 * Read the congratulated set, carrying an older file forward.
 *
 * Each migration is applied ONCE, and only to a file older than it. That is
 * not ceremony: the id carries the threshold, so a recalibration rewrites
 * ids, and a rewrite can land an OLD id on top of a LIVE one — on the spend
 * ladder, which shifted by a whole rung, `spendUsd-10` is both. Re-running
 * such a map walks the award up the ladder, one rung per pass, and the
 * awards it walks past are lost for good.
 *
 * Hence the list rather than a single map plus a hand-kept constant: a
 * later recalibration appends its own entry, every file lands on the newest
 * version by replaying only the steps it missed, and there is no version
 * number for anyone to forget to bump.
 */
export interface NotifiedFile {
  notified: Set<string>;
  /** The version on disk, so a later write cannot lower it. */
  version: number;
}

function decode(json: string | null): NotifiedFile {
  if (json === null) return { notified: new Set(), version: 0 };
  try {
    const value = JSON.parse(json) as { notified?: unknown; version?: unknown };
    if (Array.isArray(value.notified)) {
      const ids = value.notified.filter(
        (id): id is string => typeof id === "string",
      );
      // A file with no usable version is a file from before versions — the
      // only writer that ever omitted the field. Treating it as 1 replays
      // every migration, which is the safe direction: replay is now
      // self-correcting (see `reconcileCongratulated`), while skipping is not.
      const stamped = value.version;
      const version =
        typeof stamped === "number" && Number.isFinite(stamped) ? stamped : 1;
      return { notified: migrateFrom(version, ids), version };
    }
  } catch {
    // fall through to the empty baseline
  }
  return { notified: new Set(), version: 0 };
}

/** Rewrite a congratulated set through ONE id map. Unknown ids are kept as
 * they are: a set from a NEWER build must survive a downgrade intact, and an
 * id this build cannot place is not evidence it is stale. */
function remap(
  ids: Iterable<string>,
  map: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of ids) out.add(map.get(id) ?? id);
  return out;
}

/** Replay every migration this file has not been through, oldest first. */
export function migrateFrom(version: number, ids: Iterable<string>): Set<string> {
  let carried = new Set(ids);
  for (const step of NOTIFIED_MIGRATIONS) {
    if (version >= step.to) continue;
    carried = remap(carried, step.ids);
  }
  return carried;
}

/**
 * Drop congratulations the ledger does not actually support.
 *
 * A rewrite carries an award onto the tier that REPLACED it, and a
 * replacement can sit HIGHER than the tier it replaced — the spend ladder
 * moved by a whole rung. So the rewrite hands some users an award they have
 * not earned: at $60 the old "Coffee Money" ($10) becomes the new one ($100).
 * The set only ever grows, so that id would then be skipped for good on the
 * day the user genuinely crosses $100 — the banner they were owed, spent in
 * advance on a tier they never had.
 *
 * Sweeping the whole set against the ledger, rather than only what a
 * migration just introduced, is deliberate: it also repairs a file an earlier
 * build already damaged, and it makes replaying a map harmless — a second
 * pass can only produce ids the ledger will reject. That is what turns the
 * version gate from a correctness requirement into an optimisation.
 *
 * Ids outside `known` are KEPT. They belong to a newer build's catalog, and
 * "my catalog has never heard of it" is not evidence the user lacks it.
 */
export function reconcileCongratulated(
  ids: ReadonlySet<string>,
  earned: ReadonlySet<string>,
  known: ReadonlySet<string>,
): Set<string> {
  const kept = new Set<string>();
  for (const id of ids) {
    if (!known.has(id) || earned.has(id)) kept.add(id);
  }
  return kept;
}
