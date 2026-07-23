import type { PaneUsage } from "@keepdeck/plugin-api";
import {
  decodeUsageEventLine,
  encodeUsageEvent,
  USAGE_EVENT_SCHEMA_VERSION,
  USAGE_HISTORY_RETENTION_MS,
  usageDelta,
  usageDeltaEmpty,
  usageSessionKey,
  type UsageEventV2,
  type UsageObservation,
} from "../domain/usage/history";
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
}

let events: readonly UsageEventV2[] = [];
let snapshot: UsageHistorySnapshot = { ready: false, events, error: null };
let initialized = false;
let initialization: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const baselines = new Map<string, UsageObservation>();
const eventIds = new Set<string>();

function emit(error: string | null = snapshot.error): void {
  snapshot = { ready: true, events, error };
  for (const listener of [...listeners]) listener();
}

/** Load, validate and compact the history once. Analytics keeps 90 days;
 * one older latest event per session remains on disk solely as a cumulative
 * baseline, preventing resume/replay from counting it again. */
export function initUsageHistory(now = Date.now()): Promise<void> {
  if (initialization) return initialization;
  initialized = true;
  initialization = loadUsageHistory()
    .then(async (lines) => {
      const decoded: UsageEventV2[] = [];
      const latestBySession = new Map<string, UsageEventV2>();
      let needsCompact = false;
      for (const line of lines) {
        const decodedLine = decodeUsageEventLine(line);
        const event = decodedLine?.event;
        if (!event || eventIds.has(event.eventId)) {
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

      const cutoff = now - USAGE_HISTORY_RETENTION_MS;
      events = decoded.filter((event) => event.occurredAt >= cutoff);
      const retainedIds = new Set(events.map((event) => event.eventId));
      for (const event of latestBySession.values()) retainedIds.add(event.eventId);
      const retained = decoded.filter((event) => retainedIds.has(event.eventId));
      if (retained.length !== decoded.length) needsCompact = true;
      if (needsCompact) {
        await compactUsageHistory(retained.map(encodeUsageEvent));
      }
      emit(null);
    })
    .catch((error: unknown) => {
      emit(String(error));
    });
  return initialization;
}

/** Persist one pane's latest cumulative usage snapshot as a canonical delta.
 * Calls serialize behind initialization and previous appends, so two rapid
 * reports always subtract from the committed predecessor. */
export function recordPaneUsage(
  usage: PaneUsage,
  context: UsageCaptureContext,
  capturedAt = Date.now(),
): Promise<void> {
  if (!initialized) void initUsageHistory(capturedAt);
  const run = async () => {
    await initialization;
    const key = usageSessionKey({ agent: usage.agent, sessionId: context.sessionId });
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
      occurredAt: usage.reportedAt,
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

    // Deterministic id makes an uncertain append retry harmless after reload.
    if (eventIds.has(event.eventId)) {
      baselines.set(key, delta.observation);
      return;
    }
    await appendUsageHistory([encodeUsageEvent(event)]);
    eventIds.add(event.eventId);
    baselines.set(key, delta.observation);
    if (event.occurredAt >= capturedAt - USAGE_HISTORY_RETENTION_MS) {
      events = [...events, event];
      emit(null);
    }
  };
  const result = writeQueue.catch(() => {}).then(run);
  writeQueue = result;
  return result;
}

export function getUsageHistorySnapshot(): UsageHistorySnapshot {
  return snapshot;
}

export function subscribeUsageHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test isolation. Call only after outstanding mocked IO has settled. */
export function resetUsageHistoryManager(): void {
  events = [];
  snapshot = { ready: false, events, error: null };
  initialized = false;
  initialization = null;
  writeQueue = Promise.resolve();
  listeners.clear();
  baselines.clear();
  eventIds.clear();
}

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
