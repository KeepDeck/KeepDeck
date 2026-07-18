import type { Disposable } from "./disposable.ts";
import type { WorkspaceRef } from "./snapshots.ts";

/**
 * Deck lifecycle events. Subscriptions auto-dispose with the plugin — a
 * deactivated plugin cannot leak a listener.
 */
export interface PluginEvents {
  /** A workspace is closing — stop anything that belongs to it. */
  onWorkspaceClosed(cb: (e: { workspace: WorkspaceRef }) => void): Disposable;
  /** The highlighted pane changed in some workspace. */
  onPaneSelected(
    cb: (e: { workspace: WorkspaceRef; paneId: string | null }) => void,
  ): Disposable;
  /** Coarse "the deck changed" signal for cheap re-reads. */
  onDeckChanged(cb: () => void): Disposable;
}
