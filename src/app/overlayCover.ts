/**
 * Which plugin overlays say they cover the window (`ui.setOverlayCovers`),
 * keyed by the full `pluginId:entryId`. The sibling of `overlayVisibility`
 * for a different fact: visibility is whether an overlay is mounted and
 * shown, cover is whether the person is looking at it instead of the deck —
 * a Component overlay is visible while it renders nothing at all.
 *
 * One boolean is what the host acts on: layering treats any covering overlay
 * as a modal layer. Keys are cleared on a plugin's lifecycle flips, like
 * visibility — a plugin torn down mid-peek must not leave the deck paused.
 */

const covering = new Set<string>();
let snapshot = false;
const listeners = new Set<() => void>();

function publish(): void {
  const next = covering.size > 0;
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

export function setOverlayCover(key: string, covers: boolean): void {
  const had = covering.has(key);
  if (covers === had) return;
  if (covers) covering.add(key);
  else covering.delete(key);
  publish();
}

/** Forget one plugin's overlays — the deck must not stay paused behind an
 * overlay of a plugin that was disabled, restarted or crashed mid-peek. */
export function clearOverlayCover(pluginId: string): void {
  let changed = false;
  for (const key of [...covering]) {
    if (key.startsWith(`${pluginId}:`)) {
      covering.delete(key);
      changed = true;
    }
  }
  if (changed) publish();
}

/** Whether any overlay covers the window — the snapshot for
 * `useSyncExternalStore`, a primitive so it is stable by value. */
export function anyOverlayCovers(): boolean {
  return snapshot;
}

export function subscribeOverlayCover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
