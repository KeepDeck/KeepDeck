import type { PeekRequest } from "./domain/openDiff";

/**
 * The plugin-internal peek-request bus. ONE producer — the Git tab, where a
 * change row or a history scope is opened — and ONE consumer: the resident
 * `GitDiffOverlay`, which renders the diff. One slot, latest wins: a second
 * request before the consumer wakes should open the second diff, not queue
 * both. The same shape the Files plugin's open requests use.
 *
 * The tab hands the diff over instead of rendering it, because a full-window
 * overlay must not live inside the dock. A tab body is hidden with
 * `display: none` and unmounted outright when the dock closes, so a peek
 * rendered there disappeared on a tab switch and died with its state on a
 * dock close — while the Files viewer, resident since it was written,
 * survived both.
 *
 * A request PARKS rather than firing into the void: the consumer subscribes
 * from an effect, which lands after the producer's first paint, so parking
 * makes that ordering a non-question instead of a race nobody would notice.
 * Files additionally exports a "is anyone listening" probe because its other
 * producer — a terminal link — must decline a click it cannot honour; the tab
 * here has no such caller, so this bus does not answer that question.
 */

/** What rides the bus is the domain's gesture (`openDiff`). */
export type { PeekRequest };

let pending: PeekRequest | null = null;
const listeners = new Set<() => void>();

/** Park a request and wake the consumer (which may also mount later and find
 * the request waiting). */
export function requestPeek(request: PeekRequest): void {
  pending = request;
  for (const listener of [...listeners]) listener();
}

/** The pending request, consumed — a second take answers null. */
export function takePeekRequest(): PeekRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** Wake on each new request; returns the unsubscribe. */
export function subscribePeekRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
