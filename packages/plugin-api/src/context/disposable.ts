/**
 * The cleanup unit of the whole contract: every `register*` and `on*` in the
 * plugin context returns one, and the host disposes ALL of a plugin's
 * disposables when it deactivates — cleanup by construction (the Obsidian
 * model), so an explicit `deactivate` is only for resources the context
 * never saw.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * A watch the host arms AFTER handing the handle back — the OS watcher is
 * created off the calling thread. `ready` settles once that happened:
 * resolved when the watch is live, rejected when the host refused it (a path
 * outside the capability's scope, a watcher limit, a backend failure). A
 * refused handle never fires and disposing it is harmless; a fresh watch is
 * the retry. Nothing is owed on `ready` — a caller that ignores it merely
 * never learns why a quiet watch is quiet.
 */
export interface WatchHandle extends Disposable {
  readonly ready: Promise<void>;
}
