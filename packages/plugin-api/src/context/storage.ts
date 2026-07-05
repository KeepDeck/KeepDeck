/**
 * Plugin persistence, namespaced by plugin id at both scopes. Async by
 * contract even where today's backing store is synchronous in-memory state —
 * the API must survive the move to the RPC boundary unchanged.
 */
export interface PluginStorage {
  /** Per-workspace slot, persisted with the deck — dies with the workspace,
   * survives restarts. */
  workspace(wsId: string): PluginKV;
  /** App-global store in the host's data dir — survives plugin reinstalls
   * (data never lives in the plugin's install folder). */
  readonly global: PluginKV;
}

export interface PluginKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
