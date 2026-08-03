import type { StatusNormalizer } from "@keepdeck/plugin-api";
import { isRecord } from "../domain/json";
import {
  EMPTY_STATUS,
  reduceStatus,
  type PaneActivity,
  type PaneStatus,
} from "../domain/status";

/**
 * The owner of live agent-status state — one per app, outside React, the
 * sibling of `usageManager`. Verified bridge reports funnel through
 * [`report`] (the status channel authenticates tokens BEFORE calling — this
 * store never sees an unverified payload); views read the snapshot via
 * `useSyncExternalStore`.
 *
 * A FACTORY rather than module state so each test builds a fresh instance
 * with no teardown hook; the app's one instance lives in the runtime
 * (`createAppRuntime`), beside the deck store and the orchestrator, and
 * reaches consumers as a value — never as an importable module singleton.
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
  // The FULL lane state per pane — activity plus the open helper brackets.
  // Only the activity half reaches the snapshot: the brackets are how the
  // fold knows a closing turn is not an ending, not something to render.
  let statuses: ReadonlyMap<string, PaneStatus> = new Map();
  let snapshot: StatusSnapshot = { panes: new Map() };
  const listeners = new Set<() => void>();
  const normalizers = new Map<string, StatusNormalizer>();

  function emit(): void {
    const panes = new Map<string, PaneActivity>();
    for (const [id, status] of statuses) {
      if (status.activity) panes.set(id, status.activity);
    }
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
      const previous = statuses.get(paneId) ?? EMPTY_STATUS;
      const next = reduceStatus(previous, edge);
      if (next === previous) return;
      statuses = new Map(statuses).set(paneId, next);
      // Only an ACTIVITY change is a snapshot change. A helper bracket
      // opening or closing moves private state, and notifying on it would
      // re-render every subscriber and re-run the notification producers
      // for a pane that is doing exactly what it was doing before — the
      // same reason the reducer returns its input unchanged.
      if (next.activity !== previous.activity) emit();
    },

    clear(paneId) {
      if (!statuses.has(paneId)) return;
      const next = new Map(statuses);
      next.delete(paneId);
      statuses = next;
      emit();
    },

    retain(liveIds) {
      if (![...statuses.keys()].some((id) => !liveIds.has(id))) return;
      const next = new Map<string, PaneStatus>();
      for (const [id, status] of statuses) {
        if (liveIds.has(id)) next.set(id, status);
      }
      statuses = next;
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
