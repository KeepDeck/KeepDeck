import type { DownloadState, PluginContext } from "@keepdeck/plugin-api";
import { modelById } from "./modelCatalog";

export interface DownloadsSnapshot {
  active: Readonly<Record<string, DownloadState>>;
  errors: Readonly<Record<string, string>>;
}

/** Voice-specific projection over the host's one shared download manager. */
export interface ModelDownloads {
  snapshot(): DownloadsSnapshot;
  subscribe(cb: () => void): () => void;
  start(modelId: string): Promise<boolean>;
  cancel(modelId: string): void;
  anyActive(): boolean;
}

const EMPTY: DownloadsSnapshot = { active: {}, errors: {} };

export function createModelDownloads(
  ctx: PluginContext,
  onInstalled: () => void = () => {},
): ModelDownloads {
  let active: Record<string, DownloadState> = {};
  let errors: Record<string, string> = {};
  let snap: DownloadsSnapshot = EMPTY;
  const jobs = new Map<string, string>();
  const listeners = new Set<() => void>();

  function notify(): void {
    snap = { active, errors };
    for (const cb of [...listeners]) cb();
  }

  return {
    snapshot: () => snap,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    anyActive: () => Object.keys(active).length > 0,

    async start(modelId) {
      if (active[modelId]) return false;
      const model = modelById(modelId);
      if (!model?.source) {
        errors = { ...errors, [modelId]: "this model has no download source" };
        notify();
        return false;
      }
      const id = crypto.randomUUID();
      jobs.set(modelId, id);
      active = {
        ...active,
        [modelId]: {
          id,
          phase: "queued",
          received: 0,
          total: model.integrity?.bytes ?? null,
        },
      };
      if (errors[modelId]) {
        const { [modelId]: _gone, ...rest } = errors;
        errors = rest;
      }
      notify();
      let installed = false;
      try {
        for await (const state of ctx.services.downloads.start({
          id,
          source: model.source,
          target: model.target,
          integrity: model.integrity,
        })) {
          if (state.phase === "failed") {
            errors = {
              ...errors,
              [modelId]: state.error ?? "download failed",
            };
          }
          installed = state.phase === "completed";
          if (
            state.phase !== "completed" &&
            state.phase !== "cancelled" &&
            state.phase !== "failed"
          ) {
            active = { ...active, [modelId]: state };
          }
          notify();
        }
        if (installed) onInstalled();
        return installed;
      } finally {
        jobs.delete(modelId);
        const { [modelId]: _done, ...rest } = active;
        active = rest;
        notify();
      }
    },

    cancel(modelId) {
      const id = jobs.get(modelId);
      if (id) {
        void ctx.services.downloads.cancel(id).catch((error) => {
          ctx.log.warn(
            `model download cancel failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    },
  };
}
