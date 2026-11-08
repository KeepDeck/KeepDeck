import { errorMessage, type UsageCall } from "@keepdeck/plugin-api";
import { findWorkspaceOfPane } from "../domain/deck";
import { usagePlace, type UsageCallBatch } from "../domain/usage/history/capture";
import { log } from "../ipc/log";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

/**
 * The calls a pane's agent reported, booked into the usage history.
 *
 * Everything that decides WHETHER a call is the deck's is decided before a
 * call reaches here, by the checks the whole deck shares: a call arrives
 * only through the verified report lane (the pane's own process, its
 * secret, its agent), out of a store the pane's accepted binding named. This
 * adds no rule of its own about processes or sessions — so when those checks
 * learn something new (background agents, say), booking follows without a
 * change here. What it adds is WHERE: the pane's session, place, and the
 * instant the session was first seen.
 */
export interface UsageCallBook extends UsageLane {
  /** Book calls a verified report of `paneId` carried, under the session the
   * report named — or, when it named none, the session the pane holds. */
  book(paneId: string, calls: readonly UsageCall[], sessionId?: string): void;
}

/** How long calls wait to go as one booking: a burst — a file read again, a
 * resumed conversation's history — becomes one IPC per pane, not one per
 * call. */
export const BOOK_DELAY_MS = 250;

export interface UsageCallBookDeps {
  /** The usage history's booking verb. */
  book(batch: UsageCallBatch): Promise<void>;
}

export function createUsageCallBook(
  { deck, bindings, sightings }: Pick<UsageLaneContext, "deck" | "bindings" | "sightings">,
  deps: UsageCallBookDeps,
): UsageCallBook {
  let disposed = false;
  /** Batches waiting to go, one per pane and session. */
  const pending = new Map<string, UsageCallBatch & { calls: UsageCall[] }>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** A session is first seen when the deck accepts it for a pane. */
  const unsubscribeBindings = bindings.subscribe(({ paneId, sessionId }) => {
    sightings.sight(paneId, sessionId);
  });

  const flush = () => {
    timer = null;
    for (const batch of pending.values()) {
      void deps.book(batch).catch((error: unknown) => {
        log.warn(
          "web:usage",
          `usage calls of ${batch.place.paneId} not booked: ${errorMessage(error)}`,
        );
      });
    }
    pending.clear();
  };

  return {
    book(paneId, calls, reported) {
      if (disposed || calls.length === 0) return;
      const workspace = findWorkspaceOfPane(deck.getSnapshot().workspaces, paneId);
      const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
      // The report's own session first: a late report of the session the
      // pane just left is that session's, not the one the pane moved to. A
      // report that names none is the pane's current session's — taken as
      // the calls ARRIVE, so a pane that moves on while a batch waits does
      // not book the old one's calls under the new one.
      const sessionId = reported ?? pane?.session?.id;
      // A pane that left the deck, or has no session yet, has nowhere to
      // book: its calls stay in its store, and a read of it books them
      // once the pane has a session.
      if (!workspace || !pane || !sessionId) return;
      const key = `${paneId}\n${sessionId}`;
      const queued = pending.get(key);
      if (queued) {
        queued.calls.push(...calls);
      } else {
        pending.set(key, {
          agent: pane.agentType,
          sessionId,
          firstSeen: sightings.sight(paneId, sessionId),
          place: usagePlace(workspace, pane),
          calls: [...calls],
        });
      }
      timer ??= setTimeout(flush, BOOK_DELAY_MS);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeBindings();
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}
