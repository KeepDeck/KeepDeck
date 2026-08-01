import type { StatusNormalizer } from "@keepdeck/plugin-api";
import { isRecord } from "../domain/json";
import { reduceActivity, type PaneActivity } from "../domain/status";

/**
 * The owner of live agent-status state — one per app, outside React, the
 * sibling of `usageManager`. Verified bridge reports funnel through
 * [`report`] (the status channel authenticates tokens BEFORE calling — this
 * store never sees an unverified payload); views read the snapshot via
 * `useSyncExternalStore`.
 *
 * A FACTORY rather than module state so each test builds a fresh instance
 * with no teardown hook; the app's one instance is [`agentStatusTracker`].
 *
 * The tracker owns coordination only: per-CLI meaning lives in the plugin
 * normalizers registered per agent id, folding lives in the pure domain
 * reducer. Everything here is runtime-only, never persisted — activity
 * describes a live process, and a persisted "working" would resurrect next
 * launch as a lie.
 */

export interface StatusSnapshot {
  panes: ReadonlyMap<string, PaneActivity>;
}

export interface AgentStatusTracker {
  /** Register an agent's status normalizer; returns the unregister. A second
   * registration for the same id replaces the first (last plugin wins, the
   * contribution-registry convention). */
  registerNormalizer(agentId: string, normalizer: StatusNormalizer): () => void;
  /** Apply one VERIFIED bridge report. Unknown agents and unrecognizable
   * payloads are dropped silently — reporters are best-effort by design. */
  report(paneId: string, payload: unknown, at?: number): void;
  /** Start a pane's activity over: its process was deliberately retired
   * (restart, suspend) and whatever the old one was doing is no longer a
   * fact about the pane. The orchestrator calls this at the same points it
   * clears usage; the tracker never reaches back into the orchestrator. */
  clear(paneId: string): void;
  /** Drop activity for panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void;
  /** The live snapshot (stable between changes — the `useSyncExternalStore`
   * snapshot contract). */
  getSnapshot(): StatusSnapshot;
  /** Notify on every snapshot change (the `useSyncExternalStore` contract). */
  subscribe(listener: () => void): () => void;
}

export function createAgentStatusTracker(): AgentStatusTracker {
  let panes: ReadonlyMap<string, PaneActivity> = new Map();
  let snapshot: StatusSnapshot = { panes };
  const listeners = new Set<() => void>();
  const normalizers = new Map<string, StatusNormalizer>();

  function emit(): void {
    snapshot = { panes };
    for (const listener of [...listeners]) listener();
  }

  return {
    registerNormalizer(agentId, normalizer) {
      normalizers.set(agentId, normalizer);
      return () => {
        if (normalizers.get(agentId) === normalizer) {
          normalizers.delete(agentId);
        }
      };
    },

    report(paneId, payload, at = Date.now()) {
      if (!isRecord(payload) || typeof payload.agent !== "string") return;
      const normalize = normalizers.get(payload.agent);
      if (!normalize) return;
      const edge = normalize(payload, at);
      if (!edge) return;
      const next = reduceActivity(panes.get(paneId) ?? null, edge);
      if (next === panes.get(paneId)) return;
      panes = new Map(panes).set(paneId, next);
      emit();
    },

    clear(paneId) {
      if (!panes.has(paneId)) return;
      const next = new Map(panes);
      next.delete(paneId);
      panes = next;
      emit();
    },

    retain(liveIds) {
      if (![...panes.keys()].some((id) => !liveIds.has(id))) return;
      const next = new Map<string, PaneActivity>();
      for (const [id, activity] of panes) {
        if (liveIds.has(id)) next.set(id, activity);
      }
      panes = next;
      emit();
    },

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app's one tracker — composition-root state, like the usage store. */
export const agentStatusTracker: AgentStatusTracker = createAgentStatusTracker();
