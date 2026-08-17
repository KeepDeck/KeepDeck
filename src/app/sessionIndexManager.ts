import type { AgentHistory } from "@keepdeck/plugin-api";
import { describeError, log } from "../ipc/log";
import { scanAgentHistories, type HistorySource } from "./historyScan";

/** What a surface needs from the index: every agent's store (the global
 * browser) or one agent's (the spawn dialog's picker). `agent` undefined
 * means "all of it". */
interface Need {
  agent?: string;
}

export interface SessionIndexSnapshot {
  /** A scan is in flight — the browser's "indexing…" state. */
  scanning: boolean;
  /** Monotonic counter, +1 per landed batch and per settle. What a listing
   * subscribes to: a first-ever scan fills the list batch by batch instead
   * of showing emptiness until the end. */
  revision: number;
  /** The agents whose stores the LAST SETTLED scan walked — the
   * `file-erased` verdict's precondition. An agent absent here was never
   * looked at, and its absence from the index proves nothing. Empty
   * until the first scan settles. */
  scannedAgents: ReadonlySet<string>;
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
  dispose(): void;
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
): SessionIndexManager {
  let snapshot: SessionIndexSnapshot = {
    scanning: false,
    revision: 0,
    scannedAgents: new Set(),
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
    next: Omit<SessionIndexSnapshot, "scannedAgents"> & {
      scannedAgents?: ReadonlySet<string>;
    },
  ): void {
    const merged: SessionIndexSnapshot = {
      ...next,
      scannedAgents: next.scannedAgents ?? snapshot.scannedAgents,
    };
    if (
      merged.scanning === snapshot.scanning &&
      merged.revision === snapshot.revision &&
      merged.scannedAgents === snapshot.scannedAgents
    )
      return;
    snapshot = merged;
    for (const listener of [...listeners]) listener();
  }

  function run(need: Need): void {
    running = need;
    const sources = sourcesOf(need.agent);
    publish({ scanning: true, revision: snapshot.revision });
    void scanAgentHistories(sources, undefined, () => {
      // A batch landed: bump the revision so subscribed listings refresh
      // while the scan is still filling the index.
      publish({ scanning: true, revision: snapshot.revision + 1 });
    })
      .catch((e: unknown) =>
        log.warn("web:history", `scan failed: ${describeError(e)}`),
      )
      .finally(() => {
        running = null;
        // The settled scan's participants — the verdict precondition. A
        // REFUSED pass keeps the previous set: its stores were not walked
        // to a conclusion, and "we tried" is not "we looked".
        publish({
          scanning: false,
          revision: snapshot.revision + 1,
          ...(sources.length > 0
            ? {
                scannedAgents: new Set(
                  sources.map((source) => source.agentId),
                ),
              }
            : {}),
        });
        const next = queued;
        queued = null;
        if (next !== null && !disposed) run(next);
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
