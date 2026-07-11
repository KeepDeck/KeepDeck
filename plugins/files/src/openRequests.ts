/**
 * The plugin-internal hand-off between the file-open HANDLER (registered at
 * activate, no React) and the Files TAB (mounted by the host, maybe not yet):
 * the handler parks the path and asks the host to reveal the tab; the tab
 * consumes the pending request at mount and subscribes for later ones. One
 * slot, latest wins — a second click before the tab mounts should open the
 * second file, not queue both.
 */

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Park `path` and wake any mounted tab. Called by the handler BEFORE the
 * dock reveal, so a tab that mounts because of the reveal finds it waiting. */
export function requestOpen(path: string): void {
  pending = path;
  for (const listener of [...listeners]) listener();
}

/** The pending request, consumed — a second take answers null. */
export function takeOpenRequest(): string | null {
  const path = pending;
  pending = null;
  return path;
}

/** Wake on each new request; returns the unsubscribe. */
export function subscribeOpenRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
