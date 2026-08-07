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

/**
 * Where a provider session came from — the ONE thing that decides whether its
 * first cumulative snapshot is a baseline or a real delta.
 *
 * - `inherited` — resume or fork: the counters already include work this
 *   ledger may already hold. Always seeds.
 * - `fresh` — this run's own spawn minted the session. Nothing about it can
 *   be on disk, so its first turn is real usage and must be COUNTED.
 * - `unknown` — no spawn plan for the pane: attached or restored, so the
 *   session may predate this run. Seeds whenever the ledger is not fully
 *   readable, because that is when a checkpoint may exist on disk that
 *   `baselines` does not have.
 *
 * A three-way fact rather than the `baselineOnly?: boolean` it replaces: the
 * boolean could say "inherited" but had no way to say "definitely not", so
 * the manager had to treat every caller's silence as "maybe" and seed.
 */
export type UsageSessionOrigin = "fresh" | "inherited" | "unknown";

export interface UsageCaptureContext {
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
  paneId: string;
  paneName: string;
  sessionId: string;
  origin: UsageSessionOrigin;
  worktree?: UsageEventV2["worktree"];
}

/**
 * Seed, or count? The whole rule, in one place.
 *
 * `unknown` + a ledger this build cannot fully read is the case worth
 * spelling out. A CLI reports cumulative totals, so a delta with no baseline
 * IS the whole session — and `baselines` is built only from lines this build
 * DECODED, while the history it was built from is still sitting on disk.
 * Appending that total would count every token of the session a second time,
 * permanently, the moment the file becomes readable again. Appending still
 * works on a file the load could not open (`read_to_string` rejects invalid
 * UTF-8; `append` does not), so this is reachable, not theoretical.
 *
 * "Fully readable" is `complete`, NOT `loaded`, and the difference is a real
 * hole rather than a wording nicety: a downgrade past a usage-event schema
 * bump loads fine and preserves the newer build's lines WITHOUT decoding
 * them, so a session whose rows are all withheld has history on disk and no
 * entry in `baselines`. Keying on `loaded` alone counted that session's
 * entire lifetime a second time.
 *
 * `fresh` is exempt, and that exemption is the fix: the guard used to be a
 * bare `!loaded`, which is sticky for the whole process (the load is never
 * retried), so EVERY session started after one failed read had its first
 * turn seeded away — for Claude, an entire opening request with the system
 * prompt and tool schemas in it. Nothing about such a session is on disk, so
 * there was never anything to double-count.
 *
 * Residual, named rather than hidden: a pane spawned fresh whose user then
 * resumes a different session from INSIDE the CLI reports under an id that
 * may have history, and this build still calls it `fresh`. That double-counts
 * one session once, and only when the ledger is also unreadable — a strictly
 * smaller and rarer loss than the certain, repeating one it replaces.
 */
function seedsBaseline(
  origin: UsageSessionOrigin,
  readable: boolean,
): boolean {
  if (origin === "inherited") return true;
  if (origin === "fresh") return false;
  return !readable;
}

export interface UsageHistorySnapshot {
  ready: boolean;
  events: readonly UsageEventV2[];
  error: string | null;
  /**
   * Whether `events` is everything the FILE holds. `ready` only means the
   * load has finished; it says nothing about what the load could read. Two
   * states publish a ready snapshot over history that is still on disk:
   *
   * - the load FAILED, and `events` is the initial empty array;
   * - the file holds lines from a NEWER build, preserved on disk and
   *   deliberately kept out of the snapshot (see `init`).
   *
   * Neither is the same question as "is there an error right now". An append
   * after a failed load succeeds and clears the error while `events` still
   * holds nothing the file contains — which is why this is derived from
   * whether the read happened, not from the current error.
   *
   * Lines that were undecodable and COMPACTED away are not covered, and do
   * not need to be: the rewrite removed them from the file too, so what is
   * in hand really is all there is.
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
  /** Whether the ledger was READ — set once, on the load path, and never
   * cleared. Not the same question as "is there an error right now": an
   * append after a failed load succeeds and clears the error, while `events`
   * still holds nothing the file contains. */
  let loaded = false;
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
      complete: loaded && withheld === 0,
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
        loaded = true;
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
      // Seeding is the same move a resumed session already makes with no
      // checkpoint: this report becomes the baseline, and everything after it
      // is a true delta. See [`seedsBaseline`] for which origins take it.
      const delta = usageDelta(usage, previous, {
        // The same expression the snapshot publishes as `complete` — one
        // question, and a reader that acts on the ABSENCE of history has to
        // ask it the same way the snapshot's own doc says to.
        baselineOnly: seedsBaseline(context.origin, loaded && withheld === 0),
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
