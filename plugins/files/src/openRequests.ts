/**
 * The plugin-internal open-request bus. Two PRODUCERS — the terminal-link
 * file-open handler and the tree's own open gestures (double click / Enter) —
 * and ONE consumer: the resident `FilesOverlay`, which renders the single
 * `FileViewer` for both. One slot, latest wins — a second request before the
 * consumer wakes should open the second file, not queue both.
 */

export interface OpenRequest {
  /** Absolute file path to preview. */
  path: string;
  /** Breadcrumb base — the tree root when opened from the tree; absent for a
   * terminal link (the viewer then shows the absolute path). */
  root?: string;
  /** Runs when the peek closes: a tree-originated open returns focus to the
   * tree; a terminal one has nowhere to return and passes nothing. */
  onClose?: () => void;
}

let pending: OpenRequest | null = null;
const listeners = new Set<() => void>();

/** Park a request and wake the consumer (it may also mount later and find
 * the request waiting). */
export function requestOpen(request: OpenRequest): void {
  pending = request;
  for (const listener of [...listeners]) listener();
}

/** The pending request, consumed — a second take answers null. */
export function takeOpenRequest(): OpenRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** Wake on each new request; returns the unsubscribe. */
export function subscribeOpenRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether anyone is listening RIGHT NOW. The file-open handler must not
 * claim a click as handled when no consumer is alive to show it — a plugin
 * mid-teardown or a crashed overlay would otherwise swallow clicks that the
 * system opener should have taken. Same-tick check + park is race-free:
 * requests fire listeners synchronously. */
export function hasOpenRequestConsumer(): boolean {
  return listeners.size > 0;
}
