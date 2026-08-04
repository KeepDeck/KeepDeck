import type { PaneUsage } from "@keepdeck/plugin-api";
import { usageDelta, usageDeltaEmpty } from "../domain/usage/history/delta";
import {
  clampOccurredAt,
  decodeUsageEventLine,
  encodeUsageEvent,
  isFutureSchemaLine,
  USAGE_EVENT_SCHEMA_VERSION,
  usageSessionKey,
  type UsageEventV2,
  type UsageObservation,
} from "../domain/usage/history/event";
import {
  appendUsageHistory,
  compactUsageHistory,
  loadUsageHistory,
} from "../ipc/usageHistory";

export interface UsageCaptureContext {
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
  paneId: string;
  paneName: string;
  sessionId: string;
  /** This provider session begins with inherited counters (resume or fork).
   * If history has no checkpoint, its first lifetime snapshot seeds only. */
  baselineOnly?: boolean;
  worktree?: UsageEventV2["worktree"];
}

export interface UsageHistorySnapshot {
  ready: boolean;
  events: readonly UsageEventV2[];
  error: string | null;
  /**
   * Whether `events` is the WHOLE ledger. `ready` only means the load has
   * finished; it says nothing about what the load could read. Two states
   * publish a ready snapshot that is missing history:
   *
   * - the load FAILED, and `events` is still the initial empty array;
   * - the file holds lines from a NEWER build, which are preserved on disk
   *   and deliberately kept out of the snapshot (see `init`).
   *
   * A reader that only displays the events can ignore this. A reader that
   * writes a durable decision from their ABSENCE cannot: it would be acting
   * on "the user has never done this" when the truth is "this build cannot
   * see what they did".
   */
  complete: boolean;
}

/** The persistence port the manager writes through — injected, so tests
 * build an instance over fakes instead of mocking modules. */
export interface UsageHistoryIpc {
  loadUsageHistory(): Promise<string[]>;
  appendUsageHistory(lines: string[]): Promise<void>;
  compactUsageHistory(lines: string[]): Promise<void>;
}

/** The durable usage-event ledger: load-validate-compact once, append
 * canonical deltas, expose a subscribable snapshot. A factory (not module
 * globals): each instance owns its whole state, so tests construct fresh
 * ones — there is no reset hook because there is nothing shared to reset. */
export function createUsageHistoryManager(ipc: UsageHistoryIpc) {
  let events: readonly UsageEventV2[] = [];
  /** Lines this build could not read and kept out of `events` — a newer
   * build's, preserved on disk rather than compacted away. */
  let withheld = 0;
  let snapshot: UsageHistorySnapshot = {
    ready: false,
    events,
    error: null,
    complete: false,
  };
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const baselines = new Map<string, UsageObservation>();
  const eventIds = new Set<string>();

  function emit(error: string | null = snapshot.error): void {
    snapshot = {
      ready: true,
      events,
      error,
      complete: error === null && withheld === 0,
    };
    for (const listener of [...listeners]) listener();
  }

  /** Load, validate and compact the history once. History is never pruned by
   * age — the ledger IS the all-time record; compaction only drops torn,
   * duplicate and schema-migrated lines. */
  function init(): Promise<void> {
    if (initialization) return initialization;
    initialized = true;
    initialization = ipc
      .loadUsageHistory()
      .then(async (lines) => {
        const decoded: UsageEventV2[] = [];
        const preserved: string[] = [];
        const latestBySession = new Map<string, UsageEventV2>();
        let needsCompact = false;
        for (const line of lines) {
          const decodedLine = decodeUsageEventLine(line);
          const event = decodedLine?.event;
          if (!event || eventIds.has(event.eventId)) {
            // A newer build's lines are not damage: this build cannot read
            // them, but a compaction that dropped them would turn an app
            // DOWNGRADE into permanent data loss. Carried verbatim (and
            // not into the snapshot); everything else undecodable heals
            // away.
            if (!event && isFutureSchemaLine(line)) {
              preserved.push(line);
              continue;
            }
            needsCompact = true;
            continue;
          }
          if (decodedLine.migrated) needsCompact = true;
          eventIds.add(event.eventId);
          decoded.push(event);
          const key = usageSessionKey(event);
          const incumbent = latestBySession.get(key);
          if (!incumbent || event.capturedAt >= incumbent.capturedAt) {
            latestBySession.set(key, event);
            baselines.set(key, event.observation);
          }
        }

        events = decoded;
        withheld = preserved.length;
        if (needsCompact) {
          await ipc.compactUsageHistory([
            ...decoded.map(encodeUsageEvent),
            ...preserved,
          ]);
        }
        emit(null);
      })
      .catch((error: unknown) => {
        emit(String(error));
      });
    return initialization;
  }

  /** Persist one pane's latest cumulative usage snapshot as a canonical
   * delta. Calls serialize behind initialization and previous appends, so
   * two rapid reports always subtract from the committed predecessor. */
  function record(
    usage: PaneUsage,
    context: UsageCaptureContext,
    capturedAt = Date.now(),
  ): Promise<void> {
    if (!initialized) void init();
    const run = async () => {
      await initialization;
      const key = usageSessionKey({
        agent: usage.agent,
        sessionId: context.sessionId,
      });
      const previous = baselines.get(key);
      const delta = usageDelta(usage, previous, {
        baselineOnly: context.baselineOnly === true,
      });
      if (usageDeltaEmpty(delta)) {
        baselines.set(key, delta.observation);
        return;
      }
      const event: UsageEventV2 = {
        schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
        eventId: eventId(
          key,
          previous,
          delta.observation,
          usage.sequence ?? usage.reportedAt,
        ),
        // Clamped through the codec's own rule: a catch-up replay with no
        // usable timestamp reports at epoch, which must never enter the
        // ledger.
        occurredAt: clampOccurredAt(usage.reportedAt, capturedAt),
        capturedAt,
        agent: usage.agent,
        ...(usage.model ? { model: usage.model } : {}),
        workspaceId: context.workspaceId,
        workspaceName: context.workspaceName,
        workspaceCwd: context.workspaceCwd,
        paneId: context.paneId,
        paneName: context.paneName,
        sessionId: context.sessionId,
        rootSessionId: context.sessionId,
        ...(context.worktree ? { worktree: context.worktree } : {}),
        tokens: delta.tokens,
        ...(delta.cost.source === "provider"
          ? { costSource: "provider" as const, costUsd: delta.cost.usd }
          : { costSource: "unavailable" as const }),
        observation: delta.observation,
      };

      // Deterministic id makes an uncertain append retry harmless after
      // reload.
      if (eventIds.has(event.eventId)) {
        baselines.set(key, delta.observation);
        return;
      }
      await ipc.appendUsageHistory([encodeUsageEvent(event)]);
      eventIds.add(event.eventId);
      baselines.set(key, delta.observation);
      events = [...events, event];
      emit(null);
    };
    const result = writeQueue.catch(() => {}).then(run);
    writeQueue = result;
    return result;
  }

  return {
    init,
    record,
    getSnapshot: (): UsageHistorySnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's one ledger, wired to the real IPC. The named exports below are
 * its bound verbs — the stable surface main.tsx, the runtime, the capture
 * path and the React hook consume. */
const manager = createUsageHistoryManager({
  loadUsageHistory,
  appendUsageHistory,
  compactUsageHistory,
});

export const initUsageHistory = manager.init;
export const recordPaneUsage = manager.record;
export const getUsageHistorySnapshot = manager.getSnapshot;
export const subscribeUsageHistory = manager.subscribe;

function eventId(
  key: string,
  previous: UsageObservation | undefined,
  observation: UsageObservation,
  sourceSequence: number,
): string {
  const material = JSON.stringify([key, previous, observation, sourceSequence]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < material.length; index += 1) {
    const code = material.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `usage-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}
