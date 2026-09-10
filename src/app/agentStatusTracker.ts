import type { AgentStatusEvent, StatusNormalizer } from "@keepdeck/plugin-api";
import { isRecord } from "../domain/json";
import { normalizeStatusBatch } from "./statusNormalization";
import {
  answerResolves,
  reduceStatus,
  type PaneActivity,
  type PaneStatus,
} from "../domain/status";

/** Whether two projections say the same thing. Per-pane `PaneActivity` is
 * already identity-stable — the fold returns its input untouched when an
 * edge moves nothing — so reference equality per key is the whole test. */
function samePanes(
  next: ReadonlyMap<string, PaneActivity>,
  published: ReadonlyMap<string, PaneActivity>,
): boolean {
  if (next.size !== published.size) return false;
  for (const [id, activity] of next) {
    if (published.get(id) !== activity) return false;
  }
  return true;
}

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
  /** Preview without publishing, then finish once the hook reply is known.
   * A cleared/replaced pane or a newer turn invalidates the pending result. */
  prepare(paneId: string, payload: unknown, at?: number): {
    activity: PaneActivity | null;
    finish(reply?: string): void;
  };
  /** Register an agent's status normalizer; returns the unregister. A second
   * registration for the same id replaces the first (last plugin wins, the
   * contribution-registry convention). */
  registerNormalizer(agentId: string, normalizer: StatusNormalizer): () => void;
  /** Apply one VERIFIED bridge report. Unknown agents and unrecognizable
   * payloads are dropped silently — reporters are best-effort by design. */
  report(paneId: string, payload: unknown, at?: number): void;
  /** The user answered the question this pane's agent was parked on. What
   * that may resolve is [`answerResolves`]'s call; a pane it refuses is left
   * untouched, so this cannot invent activity. Narrow by construction rather
   * than by caller discipline. */
  answered(paneId: string, at?: number): void;
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
  /** Tell me when a pane's CONTEXT was rebuilt — a compaction. Whatever the
   * deck told that agent may no longer be in front of it.
   *
   * Fired on the EDGE, not on a snapshot change: a compaction leaves an
   * ordinary pane's activity untouched (the fold returns the same object on
   * purpose), so anything watching the snapshot would never see one. */
  onContextRebuilt(listener: (paneId: string) => void): () => void;
}

export function createAgentStatusTracker(): AgentStatusTracker {
  // The FULL lane state per pane — activity plus the open agent-turn
  // brackets. Only the activity half reaches the snapshot: the brackets are
  // how the fold knows a closing turn is not an ending, not something to
  // render. Decoder checkpoints may exist before the first activity, so
  // lifecycle cleanup must not use the published map as a process roster.
  let statuses: ReadonlyMap<string, PaneStatus> = new Map();
  let snapshot: StatusSnapshot = { panes: new Map() };
  const listeners = new Set<() => void>();
  const rebuilt = new Set<(paneId: string) => void>();
  const normalizers = new Map<string, StatusNormalizer>();
  const epochs = new Map<string, object>();
  const decoderStates = new Map<string, { normalize: StatusNormalizer; state: unknown }>();

  /**
   * The ONE way this store moves: adopt the next state, project it, and
   * notify — but only when the projection actually differs. Every mutator
   * goes through here, because the visibility test is the step that is easy
   * to forget at a call site, and forgetting it either wakes every
   * subscriber for a change nobody can see (a bracket opening) or, worse,
   * hides one they can.
   */
  function commit(next: ReadonlyMap<string, PaneStatus>): void {
    statuses = next;
    const panes = new Map<string, PaneActivity>();
    for (const [id, status] of statuses) panes.set(id, status.activity);
    if (samePanes(panes, snapshot.panes)) return;
    snapshot = { panes };
    for (const listener of [...listeners]) listener();
  }

  /**
   * Fold an ordered batch into a pane's lane state, publishing only once.
   * Every edge lands here whoever
   * minted it — a plugin normalizer reading a hook envelope, or the host
   * seeing the user answer — so "what an edge does to a pane" keeps the pure
   * reducer as its single answer. An edge the fold absorbs comes back as the
   * SAME object and stops here, without a store write.
   */
  function apply(paneId: string, edges: readonly AgentStatusEvent[]): void {
    const previous = statuses.get(paneId) ?? null;
    const next = edges.reduce(reduceStatus, previous);
    if (next === previous) return;
    const panes = new Map(statuses);
    if (next) panes.set(paneId, next);
    else panes.delete(paneId);
    commit(panes);
  }

  function prepare(paneId: string, payload: unknown, at = Date.now()) {
    const previous = statuses.get(paneId) ?? null;
    const ignored = { activity: previous?.activity ?? null, finish() {} };
    if (!isRecord(payload) || typeof payload.agent !== "string") return ignored;
    const agent = payload.agent;
    const normalize = normalizers.get(agent);
    if (!normalize) return ignored;
    // One root-file drain is ordered and atomic; only the plugin reads its
    // records. In particular, no subscriber sees the abort between turns.
    const payloads = payload.kind === "store.batch"
      ? (Array.isArray(payload.records) ? payload.records : []).map((record) => ({
          agent, kind: "store.record", record,
        }))
      : [payload];
    const stateNow = () => {
      const held = decoderStates.get(paneId);
      return held?.normalize === normalize ? held.state : undefined;
    };
    const normalizeAll = (reply?: string) => normalizeStatusBatch(
      normalize, payloads, at, stateNow(), reply, payload.contextOnly === true,
    );
    const initial = normalizeAll();
    const edges = initial.events;
    if (edges.length === 0 && initial.state === stateNow()) return ignored;
    const preview = edges.reduce(reduceStatus, previous);
    if (!epochs.has(paneId) || (preview !== previous && edges.some((edge) =>
      edge.kind === "turn-start" || edge.kind === "turn-observed"))) {
      epochs.set(paneId, {});
    }
    const epoch = epochs.get(paneId);
    let finished = false;
    return {
      activity: preview?.activity ?? null,
      finish(reply?: string) {
        if (finished) return;
        finished = true;
        if (epochs.get(paneId) !== epoch || normalizers.get(agent) !== normalize) return;
        // Rebase decoding on the latest committed checkpoint: metadata can
        // arrive while a hook reply is in flight. Preview never consumed it.
        const settled = normalizeAll(reply);
        if (settled.state === undefined) decoderStates.delete(paneId);
        else decoderStates.set(paneId, { normalize, state: settled.state });
        // A delayed start must not overwrite a newer wait or ending. Once
        // other evidence has arrived it obeys the source-time start guard.
        const current = statuses.get(paneId) ?? null;
        const guarded = settled.events.map((edge): AgentStatusEvent =>
          current !== previous && edge.kind === "turn-start"
            ? { kind: "turn-observed", at: edge.at } : edge);
        for (const edge of guarded) {
          if (edge.kind === "context-compacted") {
            for (const listener of [...rebuilt]) listener(paneId);
          }
        }
        apply(paneId, guarded);
      },
    };
  }

  return {
    prepare,
    registerNormalizer(agentId, normalizer) {
      normalizers.set(agentId, normalizer);
      return () => {
        if (normalizers.get(agentId) === normalizer) {
          normalizers.delete(agentId);
        }
      };
    },

    report(paneId, payload, at = Date.now()) {
      prepare(paneId, payload, at).finish();
    },

    answered(paneId, at = Date.now()) {
      // What an answer may resolve is the domain's call, next to the fold
      // that reads the same edge from an agent — asking it here in a second
      // spelling is how the two readings drift apart.
      if (!answerResolves(statuses.get(paneId)?.activity ?? null)) return;
      apply(paneId, [{ kind: "resumed", at }]);
    },

    clear(paneId) {
      epochs.delete(paneId);
      decoderStates.delete(paneId);
      if (!statuses.has(paneId)) return;
      const next = new Map(statuses);
      next.delete(paneId);
      commit(next);
    },

    retain(liveIds) {
      for (const id of decoderStates.keys()) {
        if (!liveIds.has(id)) decoderStates.delete(id);
      }
      for (const id of epochs.keys()) {
        if (!liveIds.has(id)) epochs.delete(id);
      }
      if (![...statuses.keys()].some((id) => !liveIds.has(id))) return;
      const next = new Map<string, PaneStatus>();
      for (const [id, status] of statuses) {
        if (liveIds.has(id)) next.set(id, status);
      }
      commit(next);
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

    onContextRebuilt(listener) {
      rebuilt.add(listener);
      return () => {
        rebuilt.delete(listener);
      };
    },
  };
}
