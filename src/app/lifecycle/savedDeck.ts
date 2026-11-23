/**
 * The machine hears which deck revision is on disk. A deck command is
 * durable only once a save at or past its revision is reported — so the
 * report must not be lost: not to a report that failed, and not to a
 * machine that started over and has heard no save yet. A command asked
 * again after a restart is answered «unchanged» at a revision already on
 * disk, and nothing new may ever be saved to say so.
 */

/** How long a failed report waits before it is sent again. */
export const SAVED_RETRY_MS = 1_000;

export interface SavedDeckReporter {
  /** A save reached disk at `revision`. */
  saved(revision: number): void;
  /** The machine is up again and has heard the deck: say what is on disk. */
  again(): void;
  dispose(): void;
}

export interface SavedDeckReporterDeps {
  report(revision: number): Promise<void>;
  warn(message: string): void;
  /** `setTimeout`, injected so tests drive the clock. Returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
}

export function createSavedDeckReporter(deps: SavedDeckReporterDeps): SavedDeckReporter {
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  /** The newest revision on disk, once one is. */
  let newest: number | null = null;
  let retry: (() => void) | null = null;
  let disposed = false;

  const send = () => {
    if (disposed || newest === null) return;
    const revision = newest;
    void deps.report(revision).catch((error: unknown) => {
      deps.warn(`reporting the saved deck at revision ${revision} failed: ${String(error)}`);
      // Sent again unless a newer save has said more meanwhile.
      if (disposed || retry !== null || newest !== revision) return;
      retry = schedule(() => {
        retry = null;
        send();
      }, SAVED_RETRY_MS);
    });
  };

  return {
    saved(revision) {
      newest = revision;
      send();
    },
    again: send,
    dispose() {
      disposed = true;
      retry?.();
      retry = null;
    },
  };
}
