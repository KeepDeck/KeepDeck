import type { PluginKV } from "@keepdeck/plugin-api";
import type { Workspace } from "../domain/deck";
import type { WorkspaceInstance } from "../domain/workspaceInstance";
import { isRecord } from "../domain/json";

/**
 * The deck-backed workspace KV behind `ctx.storage.workspace(wsId)`. A
 * plugin's whole slot (`ws.plugins[pluginId]`) is one flat object; each KV
 * key is a property of it. Writes go through the deck reducer (the
 * `setWorkspacePluginSlot` action), so persistence, save debouncing and
 * workspace deletion all come for free with the deck document.
 *
 * Access to the live deck arrives through a late-bound accessor pair rather
 * than a captured state object: the deck lives in React (`useDeck`), and the
 * manager wiring (`usePluginDeckBridge`) keeps the accessor pointed at the
 * CURRENT render's state.
 */
export interface DeckAccess {
  workspaces(): Workspace[];
  setPluginSlot(
    wsId: string,
    workspaceInstance: WorkspaceInstance,
    pluginId: string,
    value: unknown,
  ): void;
}

export function makeWorkspaceKv(
  access: DeckAccess,
  pluginId: string,
  wsId: string,
): PluginKV {
  // A handle belongs to the workspace lifetime that existed when it was
  // requested. An unknown workspace captures no lifetime and can never attach
  // itself to a future workspace that happens to reuse the same public id.
  const workspaceInstance = access
    .workspaces()
    .find((workspace) => workspace.id === wsId)?.instance;
  const workspace = (): Workspace | undefined =>
    workspaceInstance === undefined
      ? undefined
      : access
          .workspaces()
          .find(
            (candidate) =>
              candidate.id === wsId && candidate.instance === workspaceInstance,
          );
  const slot = (): Record<string, unknown> => {
    const value = workspace()?.plugins?.[pluginId];
    return isRecord(value) ? value : {};
  };
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return slot()[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (workspaceInstance === undefined || !workspace()) return;
      access.setPluginSlot(wsId, workspaceInstance, pluginId, {
        ...slot(),
        [key]: value,
      });
    },
    async delete(key: string): Promise<void> {
      if (workspaceInstance === undefined || !workspace()) return;
      const { [key]: _gone, ...rest } = slot();
      // An emptied slot is deleted outright (`undefined`), keeping the
      // persisted document sparse — the reducer drops the empty bag.
      access.setPluginSlot(
        wsId,
        workspaceInstance,
        pluginId,
        Object.keys(rest).length > 0 ? rest : undefined,
      );
    },
  };
}

/**
 * Global plugin storage is NOT implemented on the built-in tier yet: it needs
 * its own durable file next to deck.json (a Rust command that lands with the
 * external tier's install layout). Reads answer "nothing stored"; writes
 * REJECT loudly — silently dropping a write would be invented durability.
 */
export function makeGlobalKvStub(
  warn: (message: string) => void,
): PluginKV {
  return {
    async get<T>(): Promise<T | undefined> {
      return undefined;
    },
    async set(key: string): Promise<void> {
      warn(`global storage is not available yet (set "${key}" rejected)`);
      throw new Error("plugin global storage is not implemented yet");
    },
    async delete(key: string): Promise<void> {
      warn(`global storage is not available yet (delete "${key}" rejected)`);
      throw new Error("plugin global storage is not implemented yet");
    },
  };
}
