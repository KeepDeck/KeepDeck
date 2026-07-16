import type { PluginContext } from "@keepdeck/plugin-api";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";

export interface ModelsStore {
  snapshot(): VoiceModelInfo[] | null;
  /** Wait for the newest catalog/install-state read and return its snapshot. */
  current(): Promise<readonly VoiceModelInfo[]>;
  subscribe(cb: () => void): () => void;
  refresh(): Promise<void>;
  error(): string | null;
}

export function createModelsStore(ctx: PluginContext): ModelsStore {
  let models: VoiceModelInfo[] | null = null;
  let err: string | null = null;
  let revision = 0;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const cb of [...listeners]) cb();
  }

  function refresh(): Promise<void> {
    const mine = ++revision;
    const request = (async () => {
      try {
        const supported = new Set(await ctx.services.speech.engines());
        const available = MODEL_CATALOG.filter((model) =>
          supported.has(model.engine),
        );
        const next = await Promise.all(
          available.map(async (model) => ({
            ...model,
            installed: await ctx.services.downloads.exists(
              model.target,
              model.integrity,
            ),
          })),
        );
        if (mine !== revision) return;
        models = next;
        err = null;
        notify();
      } catch (error) {
        if (mine !== revision) return;
        err = error instanceof Error ? error.message : String(error);
        notify();
      }
    })();
    const tracked = request.finally(() => {
      if (pending === tracked) pending = null;
    });
    pending = tracked;
    return tracked;
  }

  void refresh();

  return {
    snapshot: () => models,
    async current() {
      // A refresh may be replaced while this call is waiting; always join the
      // newest generation before selecting an inference model.
      while (pending) await pending;
      if (models) return models;
      throw new Error(err ?? "speech models are not ready");
    },
    error: () => err,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh,
  };
}
