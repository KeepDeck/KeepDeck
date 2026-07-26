import type { Disposable, PluginContext } from "@keepdeck/plugin-api";
import { DEFAULT_BINDINGS, parseBindings, type VoiceBindings } from "./binding";

export interface BindingsStore {
  /** The current bindings — synchronous, for the hotkey handler. */
  get(): VoiceBindings;
  /** Stable snapshot for useSyncExternalStore (same reference until a change). */
  snapshot(): VoiceBindings;
  subscribe(cb: () => void): () => void;
  /**
   * Read the persisted bindings and follow later edits. Call this only once the
   * plugin's settings SECTION is registered: the host resolves a plugin's stored
   * values against the fields it has declared, so a read taken before that
   * answers with an empty bag — and since nothing writes settings at boot, the
   * store would then sit on the defaults for the whole session.
   */
  load(): void;
  /** Stop tracking settings changes. */
  dispose(): void;
}

/**
 * Holds the live push-to-talk bindings: read from the plugin's settings values
 * and kept current as the user edits them, so the hotkey handler, the settings
 * recorder, and the help copy all read ONE truth. Until [`load`] resolves, the
 * shipped defaults stand, so the hotkeys work from the first frame.
 */
export function createBindingsStore(ctx: PluginContext): BindingsStore {
  let bindings: VoiceBindings = DEFAULT_BINDINGS;
  let sub: Disposable | null = null;
  const listeners = new Set<() => void>();

  function apply(values: Record<string, unknown>): void {
    bindings = parseBindings(values);
    for (const cb of [...listeners]) cb();
  }

  return {
    get: () => bindings,
    snapshot: () => bindings,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    load() {
      // A write from the settings recorder persists through the host and comes
      // back here via onChange — one loop keeps every reader in sync.
      void ctx.settings.read().then(apply);
      sub = ctx.settings.onChange(apply);
    },
    dispose() {
      sub?.dispose();
      sub = null;
    },
  };
}
