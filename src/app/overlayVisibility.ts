/**
 * Visibility of plugin overlays (`ui.setOverlayVisible`), keyed by the full
 * `pluginId:entryId`. A tiny external store in the house idiom: a stable
 * snapshot rebuilt only on real change, so `useSyncExternalStore` never
 * loops. ABSENCE is meaningful — an overlay with no entry falls back to its
 * tier's default (Component = visible, iframe = hidden), decided at the
 * render site. Because keys are STABLE across a plugin's restart/re-enable,
 * a stale `true` would override the iframe tier's hidden default and bring
 * a returning overlay back full-window — so plugin lifecycle flips clear
 * the plugin's keys ([`clearOverlayVisibility`]).
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

/** Forget one plugin's visibility choices — a restarted or re-enabled
 * plugin's overlays must come back on their TIER DEFAULTS (iframe = hidden),
 * not on last session's word, or a returning full-window frame would swallow
 * clicks before the plugin's activate says anything. */
export function clearOverlayVisibility(pluginId: string): void {
  let changed = false;
  for (const key of [...state.keys()]) {
    if (key.startsWith(`${pluginId}:`)) {
      state.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
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
