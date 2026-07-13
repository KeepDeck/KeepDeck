import type { PluginContext } from "@keepdeck/plugin-api";

/**
 * The download manager — one per plugin activation, held in the runtime so it
 * OUTLIVES any component. The settings model cards mount and unmount as the
 * settings dialog opens and closes; the Rust transfer runs in the background
 * regardless, and this manager is what keeps its progress attached to the UI
 * across that unmount. Both the settings cards and the dock tab read it, so a
 * download started in settings still shows its state after settings close.
 */
export interface DownloadState {
  /** 0–100 when the server sent a length, else null (indeterminate). */
  percent: number | null;
}

export interface DownloadsSnapshot {
  /** Active downloads by model id. Absent = not downloading. */
  active: Readonly<Record<string, DownloadState>>;
  /** Last error per model id, cleared when a new download starts. A cancel
   * is NOT an error — the partial file stays and Download resumes it. */
  errors: Readonly<Record<string, string>>;
}

export interface DownloadManager {
  snapshot(): DownloadsSnapshot;
  subscribe(cb: () => void): () => void;
  /** Start (or resume) a download. Idempotent per id — a second call while
   * one is live is a no-op. Resolves true when the model is installed. */
  start(id: string): Promise<boolean>;
  cancel(id: string): void;
  /** Whether anything is downloading — the dock indicator's gate. */
  anyActive(): boolean;
}

const EMPTY: DownloadsSnapshot = { active: {}, errors: {} };

/** `onInstalled` fires after a download completes and the model is on disk —
 * the models store refreshes through it, so a finished download flips the
 * dock's "no model" prompt without anyone polling. */
export function createDownloadManager(
  ctx: PluginContext,
  onInstalled: () => void = () => {},
): DownloadManager {
  let active: Record<string, DownloadState> = {};
  let errors: Record<string, string> = {};
  let snap: DownloadsSnapshot = EMPTY;
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

    async start(id) {
      if (active[id]) return false;
      active = { ...active, [id]: { percent: 0 } };
      if (errors[id]) {
        const { [id]: _gone, ...rest } = errors;
        errors = rest;
      }
      notify();
      try {
        await ctx.services.voice.downloadModel(id, ({ received, total }) => {
          active = {
            ...active,
            [id]: { percent: total ? Math.round((received / total) * 100) : null },
          };
          notify();
        });
        onInstalled();
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A cancel is a quiet reset — the partial stays, Download resumes it.
        if (message !== "cancelled") errors = { ...errors, [id]: message };
        return false;
      } finally {
        const { [id]: _done, ...rest } = active;
        active = rest;
        notify();
      }
    },

    cancel(id) {
      void ctx.services.voice.cancelDownload(id);
    },
  };
}
