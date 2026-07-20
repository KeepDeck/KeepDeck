import type { PluginContext } from "@keepdeck/plugin-api";
import { DEFAULT_BINDINGS, parseBindings, type VoiceBindings } from "./binding";

export interface BindingsStore {
  /** The current bindings — synchronous, for the hotkey handler. */
  get(): VoiceBindings;
  /** Stable snapshot for useSyncExternalStore (same reference until a change). */
  snapshot(): VoiceBindings;
  subscribe(cb: () => void): () => void;
  /** Stop tracking settings changes. */
  dispose(): void;
}

/**
 * Holds the live push-to-talk bindings: seeded from the plugin's settings
 * values and kept current as the user edits them, so the hotkey handler, the
 * settings recorder, and the help copy all read ONE truth. Until the initial
 * read resolves, the shipped defaults stand, so the hotkeys work from the
 * first frame.
 */
export function createBindingsStore(ctx: PluginContext): BindingsStore {
  let bindings: VoiceBindings = DEFAULT_BINDINGS;
  const listeners = new Set<() => void>();

  function apply(values: Record<string, unknown>): void {
    bindings = parseBindings(values);
    for (const cb of [...listeners]) cb();
  }

  // A write from the settings recorder persists through the host and comes
  // back here via onChange — one loop keeps every reader in sync.
  void ctx.settings.read().then(apply);
  const sub = ctx.settings.onChange(apply);

  return {
    get: () => bindings,
    snapshot: () => bindings,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => sub.dispose(),
  };
}
