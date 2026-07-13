import type { PluginContext, VoiceModelInfo } from "@keepdeck/plugin-api";

/**
 * The model list, held once at the plugin level so every view shares ONE
 * source of install state. The settings cards and the dock tab both read it;
 * a delete in settings or a finished download updates it in place, so the
 * tab's "no model yet" prompt appears and disappears without reopening.
 */
export interface ModelsStore {
  /** The list, or null until the first load resolves. */
  snapshot(): VoiceModelInfo[] | null;
  subscribe(cb: () => void): () => void;
  /** Re-read the registry from the backend. Call after any change (delete,
   * download) — every subscriber re-renders. */
  refresh(): Promise<void>;
  /** Last read error, if the list couldn't load. */
  error(): string | null;
}

export function createModelsStore(ctx: PluginContext): ModelsStore {
  let models: VoiceModelInfo[] | null = null;
  let err: string | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const cb of [...listeners]) cb();
  }

  async function refresh(): Promise<void> {
    try {
      models = await ctx.services.voice.models();
      err = null;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    notify();
  }

  // Load once on creation; views render the null snapshot until it lands.
  void refresh();

  return {
    snapshot: () => models,
    error: () => err,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh,
  };
}
