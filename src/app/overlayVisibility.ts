/**
 * Visibility of plugin overlays (`ui.setOverlayVisible`), keyed by the full
 * `pluginId:entryId`. A tiny external store in the house idiom: a stable
 * snapshot rebuilt only on real change, so `useSyncExternalStore` never
 * loops. ABSENCE is meaningful — an overlay with no entry falls back to its
 * tier's default (Component = visible, iframe = hidden), decided at the
 * render site. Stale keys for gone overlays are inert (lookups only), so
 * nothing here needs plugin-lifecycle cleanup.
 */

const state = new Map<string, boolean>();
let snapshot: ReadonlyMap<string, boolean> = new Map();
const listeners = new Set<() => void>();

export function setOverlayVisibility(key: string, visible: boolean): void {
  if (state.get(key) === visible) return;
  state.set(key, visible);
  snapshot = new Map(state);
  for (const listener of [...listeners]) listener();
}

/** The stable snapshot for `useSyncExternalStore`. */
export function overlayVisibility(): ReadonlyMap<string, boolean> {
  return snapshot;
}

export function subscribeOverlayVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
