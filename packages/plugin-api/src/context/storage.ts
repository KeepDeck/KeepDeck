import type { WorkspaceRef } from "./snapshots.ts";

/**
 * Plugin persistence, namespaced by plugin id at both scopes. Async by
 * contract even where today's backing store is synchronous in-memory state —
 * the API must survive the move to the RPC boundary unchanged.
 */
export interface PluginStorage {
  /** Per-workspace slot, persisted with the deck — dies with the workspace,
   * survives restarts. The lifetime ref prevents a delayed operation from
   * attaching to a replacement that reused the same public id. */
  workspace(workspace: WorkspaceRef): PluginKV;
  /** App-global store in the host's data dir — survives plugin reinstalls
   * (data never lives in the plugin's install folder). */
  readonly global: PluginKV;
}

/**
 * A private directory for this plugin and one workspace (API 71), outside
 * every repository, so nothing in it needs a git exclude. Made on the first
 * `dir()` call, never at activation; the plugin may write inside it through
 * `services.fsWrite` without declaring a write capability, and nowhere else
 * on its strength. It goes with the workspace. Ask each time rather than
 * keeping the path: the host's home may move between launches.
 */
export interface PluginWorkspaces {
  /** The directory, created when missing. Rejects a workspace the deck no
   * longer holds. */
  dir(workspace: WorkspaceRef): Promise<string>;
}

export interface PluginKV {
  /** Read one value through a guard the CALLER owns: a stored value the
   * guard refuses reads as `undefined`, exactly like a missing key. The
   * plugin is the only side that knows what it wrote, so it is the side
   * that proves the shape on the way back. */
  get<T>(key: string, accepts: (value: unknown) => value is T): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
