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
