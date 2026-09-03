/**
 * The "an artifact changed" signal — one per app, outside React, like
 * `notificationCenter`.
 *
 * Every publish and delete in this app goes through the artifact
 * commands (the MCP tools are that registry's projection), so a surface
 * showing the store's contents can be TOLD instead of asked. The signal
 * carries no payload: what changed is on disk, and a reader that wants
 * the new shape re-reads it.
 *
 * Revision rather than a bare callback so a subscriber can be a
 * `useSyncExternalStore` source: React needs a value it can compare, and
 * a monotonic count is the smallest honest one.
 *
 * Not covered, deliberately: a store edited from OUTSIDE the app (a
 * manual `rm -rf`, which the store's own docs call normal operation).
 * Nothing observes the filesystem, so a surface left open across such an
 * edit is stale until it is reopened.
 */
export interface ArtifactChanges {
  /** How many artifact writes this app has made. */
  revision(): number;
  subscribe(listener: () => void): () => void;
  /** Announce a publish or a delete that LANDED. */
  changed(): void;
}

export function createArtifactChanges(): ArtifactChanges {
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    changed() {
      revision += 1;
      // A copy: a listener that unsubscribes inside its own call would
      // otherwise mutate the set being iterated.
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The app's one channel. */
export const artifactChanges = createArtifactChanges();
