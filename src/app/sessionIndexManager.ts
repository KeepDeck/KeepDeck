import type { AgentHistory } from "@keepdeck/plugin-api";
import { describeError, log } from "../ipc/log";
import { rowKeyOf } from "../domain/journal/sessionRow";
import {
  scanAgentHistories,
  type HistorySource,
  type ScanReport,
} from "./historyScan";

/** What a surface needs from the index: every agent's store (the global
 * browser) or one agent's (the spawn dialog's picker). `agent` undefined
 * means "all of it". */
interface Need {
  agent?: string;
}

export interface SessionIndexSnapshot {
  /** A scan is in flight — the browser's "Indexing…" state. */
  scanning: boolean;
  /** Monotonic counter, +1 per landed batch and per settle. What a listing
   * subscribes to: a first-ever scan fills the list batch by batch instead
   * of showing emptiness until the end. */
  revision: number;
  /** The "agent:sessionId" keys the last settled scan PRUNED from the
   * index — sessions that WERE there and are not anymore. Per-key answer
   * caches devalue exactly these (a hit that outlived its session is a
   * lie); identity changes ONLY when a pass actually dropped something. */
  invalidated: ReadonlySet<string>;
}

/** The agent-contribution registry as this owner needs it: history-bearing
 * contributions, and a change signal (a plugin registered late must release
 * needs that arrived before it). */
export interface SessionIndexRegistry {
  list(): ReadonlyArray<{ entry: { id: string; history?: AgentHistory } }>;
  subscribe(listener: () => void): () => void;
}

export interface SessionIndexManager {
  /** The live snapshot (stable between changes — the `useSyncExternalStore`
   * snapshot contract). */
  snapshot(): SessionIndexSnapshot;
  /** Notify on every snapshot change (the `useSyncExternalStore` contract). */
  subscribe(listener: () => void): () => void;
  /** A surface DECLARES its need for fresh data; whether and when a scan
   * runs is this owner's call — deduped against the running one, chained
   * behind it when the scope differs, deferred while the registry holds no
   * sources at all. Void on purpose: results arrive by subscription, and a
   * Promise would only tempt an `await` into an effect. */
  ensureFresh(agent?: string): void;
  /** The store behind `agent` (or every store) has changed under us —
   * whatever was scanned before this moment no longer counts as fresh.
   * Called from the binding lane, which is where the app learns that a
   * session has come into being; without it the freshness window would
   * hide a just-spawned agent's session for as long as it lasts. */
  invalidate(agent?: string): void;
  dispose(): void;
}

/**
 * How long a settled pass answers for its scope.
 *
 * The value only has to outlive one gesture. The pass this saves is the
 * repeat: open the spawn dialog, look at two agents, close it, open it
 * again — four passes over stores that nothing touched in between, because
 * the dialog declares a need on mount AND on every agent switch. A minute
 * covers that gesture with room to spare.
 *
 * It is deliberately NOT the whole story: a window alone would hide a
 * session the user just created. `invalidate` is what makes the policy
 * safe, and the window is only what it falls back to for changes the app
 * never hears about — a session started in the user's own terminal, or one
 * deleted from disk behind our back.
 */
const FRESH_MS = 60_000;

export interface SessionIndexOptions {
  /** Injected so tests move time instead of waiting for it. */
  now?: () => number;
}

/** Merge two needs into the one pass that satisfies both: identical scopes
 * stay narrow, anything else widens to the full sweep (two different agents
 * asked for = scan everyone once, not twice). */
function mergeNeeds(a: Need | null, b: Need): Need {
  if (a === null) return b;
  if (a.agent === undefined || b.agent === undefined) return {};
  if (a.agent === b.agent) return a;
  return {};
}

/**
 * The single owner of the session-search index's freshness policy — the
 * sibling of `usageManager` and `agentStatusTracker`. Surfaces (the history
 * browser, the spawn dialog's picker) only declare a need via
 * `ensureFresh`; which stores to walk, when to coalesce two needs into one
 * pass, how to chain a wider need behind a running narrow one, and how long
 * to wait for plugin registration all live HERE, once. The scan mechanics
 * themselves stay in [`scanAgentHistories`] — this owner decides, it does
 * not re-implement.
 *
 * A FACTORY rather than module state so each test builds a fresh instance;
 * the app's one instance lives in the runtime (`createAppRuntime`) beside
 * the other owners and reaches consumers as a value.
 */
export function createSessionIndexManager(
  registry: SessionIndexRegistry,
  options: SessionIndexOptions = {},
): SessionIndexManager {
  const now = options.now ?? (() => Date.now());
  let snapshot: SessionIndexSnapshot = {
    scanning: false,
    revision: 0,
    invalidated: new Set(),
  };
  const listeners = new Set<() => void>();
  /** The pass currently running; null when idle. */
  let running: Need | null = null;
  /** The merged pass to run once `running` settles — never dropped: a
   * picker's narrow scan can't stand in for the browser's full sweep. */
  let queued: Need | null = null;
  /** Needs declared while the registry had NO history sources at all. Not
   * "resolved as success": a scan before plugin registration would
   * "successfully" index zero stores, and the first request at app start
   * would be eaten. They hang until the registry says something exists. */
  let deferred: Need | null = null;
  let disposed = false;
  /** Bumped by every `invalidate`. A pass reads it at START and writes its
   * freshness record only if it still matches at settle: a pass that was
   * already walking the store when the change landed did not see it, and
   * must not answer for the state that followed. Without this the window
   * would be armed by a pass that is provably behind. */
  let epoch = 0;
  /** When a full sweep last settled on an unchanged epoch; null when none
   * has, or when one was invalidated. */
  let fullSettledAt: number | null = null;
  /** The same, per agent, for the narrow passes the spawn dialog asks for.
   * Cleared by a full sweep — that sweep covers every agent, and one record
   * answering for all of them is cheaper than N copies of the same instant. */
  const agentSettledAt = new Map<string, number>();

  /** Is this need already answered? Asymmetric on purpose: a full sweep
   * covers a narrow need, but a narrow pass says NOTHING about the agents it
   * did not walk, so it can never satisfy a full one. Getting this backwards
   * would silently starve the browser's sweep — no error, just an index
   * quietly drifting from the stores. */
  function isFresh(need: Need): boolean {
    const full = fullSettledAt ?? Number.NEGATIVE_INFINITY;
    const at =
      need.agent === undefined
        ? full
        : Math.max(
            agentSettledAt.get(need.agent) ?? Number.NEGATIVE_INFINITY,
            full,
          );
    return Number.isFinite(at) && now() - at < FRESH_MS;
  }

  function hasAnySource(): boolean {
    return registry.list().some((c) => c.entry.history !== undefined);
  }

  function sourcesOf(agent?: string): HistorySource[] {
    return registry
      .list()
      .flatMap((c) =>
        c.entry.history
          ? [{ agentId: c.entry.id, history: c.entry.history }]
          : [],
      )
      .filter((s) => agent === undefined || s.agentId === agent);
  }

  /** The ONE way the snapshot moves: adopt the next state and notify — but
   * only when something actually changed. Forgetting this test is how
   * `useSyncExternalStore` loops (the UsageChips lesson). */
  function publish(
    next: Omit<SessionIndexSnapshot, "invalidated"> & {
      invalidated?: ReadonlySet<string>;
    },
  ): void {
    const merged: SessionIndexSnapshot = {
      ...next,
      invalidated: next.invalidated ?? snapshot.invalidated,
    };
    if (
      merged.scanning === snapshot.scanning &&
      merged.revision === snapshot.revision &&
      merged.invalidated === snapshot.invalidated
    )
      return;
    snapshot = merged;
    for (const listener of [...listeners]) listener();
  }

  function run(need: Need): void {
    running = need;
    const epochAtStart = epoch;
    const sources = sourcesOf(need.agent);
    publish({ scanning: true, revision: snapshot.revision });
    // What the settling pass carries, staged by `.then` and applied by
    // the SINGLE settle publish in `.finally` — two publishes would
    // double-bump the revision.
    let invalidNow: Set<string> | null = null;
    void scanAgentHistories(sources, undefined, () => {
      // A batch landed: bump the revision so subscribed listings refresh
      // while the scan is still filling the index.
      publish({ scanning: true, revision: snapshot.revision + 1 });
    })
      .then((report: ScanReport) => {
        // The pruned keys — REPLACED per pass (last answer wins): the
        // caches devalue each list once, when it lands. Identity moves
        // only when something actually dropped. `rowKeyOf` — the one
        // spelling: consumers delete by these keys from tables filled
        // through the same helper, and a second pen would miss in
        // silence.
        if (report.dropped.length > 0) {
          invalidNow = new Set(report.dropped.map((k) => rowKeyOf(k)));
        }
      })
      .catch((e: unknown) => {
        log.warn("web:history", `scan failed: ${describeError(e)}`);
      })
      .finally(() => {
        running = null;
        // The pass answers for its scope only if nothing changed under it
        // while it walked. A full sweep drops the per-agent records: it
        // covers all of them, and `isFresh` already falls back to this one.
        if (epochAtStart === epoch) {
          if (need.agent === undefined) {
            fullSettledAt = now();
            agentSettledAt.clear();
          } else {
            agentSettledAt.set(need.agent, now());
          }
        }
        if (invalidNow !== null) {
          publish({
            scanning: false,
            revision: snapshot.revision + 1,
            invalidated: invalidNow,
          });
        } else {
          publish({ scanning: false, revision: snapshot.revision + 1 });
        }
        const next = queued;
        queued = null;
        // Re-asked, not replayed: a need can wait a long time behind a slow
        // pass, and the pass that just settled may be exactly what it wanted
        // (a full sweep answers a narrow need queued behind it).
        if (next !== null && !disposed && !isFresh(next)) run(next);
      });
  }

  const unsubscribeRegistry = registry.subscribe(() => {
    if (deferred === null || disposed || !hasAnySource()) return;
    const need = deferred;
    deferred = null;
    // Only a running pass blocks it now; the ensureFresh guards would have
    // queued it otherwise.
    if (running === null) run(need);
    else queued = mergeNeeds(queued, need);
  });

  return {
    snapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ensureFresh(agent) {
      if (disposed) return;
      const need: Need = agent === undefined ? {} : { agent };
      // Answered already — the cheapest pass is the one that never runs.
      // Asked before the running/deferred branches because a fresh answer
      // is a fresh answer whatever else is in flight.
      if (isFresh(need)) return;
      if (running !== null) {
        // A running pass already covering the need satisfies it — the
        // narrowest dedup there is. Anything wider chains behind.
        if (running.agent === undefined || running.agent === need.agent) return;
        queued = mergeNeeds(queued, need);
        return;
      }
      // The registry itself empty of sources is "not ready", not "done":
      // hang the need until a plugin registers (see `deferred`).
      if (!hasAnySource()) {
        deferred = mergeNeeds(deferred, need);
        return;
      }
      run(need);
    },

    invalidate(agent) {
      if (disposed) return;
      // The bump lands even when nothing was recorded yet: a pass ALREADY
      // RUNNING is the case this exists for, and it reads the epoch, not
      // the records.
      epoch += 1;
      // A full record answered for this agent too, so a narrow change
      // retires it as well — keeping it would let the next full-covered
      // narrow need read a store we know has moved.
      fullSettledAt = null;
      if (agent === undefined) agentSettledAt.clear();
      else agentSettledAt.delete(agent);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeRegistry();
      listeners.clear();
      // A scan in flight is allowed to finish — its notifies find nobody,
      // and the chained `run` is stopped by `disposed`.
    },
  };
}
