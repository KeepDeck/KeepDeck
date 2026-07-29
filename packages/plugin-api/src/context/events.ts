import type { Disposable } from "./disposable.ts";
import type { WorkspaceRef } from "./snapshots.ts";

/**
 * Deck lifecycle events. Subscriptions auto-dispose with the plugin — a
 * deactivated plugin cannot leak a listener.
 */
export interface PluginEvents {
  /** A workspace is closing — stop anything that belongs to it. */
  onWorkspaceClosed(cb: (e: { workspace: WorkspaceRef }) => void): Disposable;
  /** The highlighted pane changed, in the ACTIVE workspace — which the event
   * always names, and which is why it also fires when the ACTIVE WORKSPACE
   * itself changes (the selection is then read from the new one). A plugin
   * surface that outlives the dock — a resident overlay — has no other way to
   * learn it is now showing something from a workspace the user has left. */
  onPaneSelected(
    cb: (e: { workspace: WorkspaceRef; paneId: string | null }) => void,
  ): Disposable;
  /** Coarse "the deck changed" signal for cheap re-reads. */
  onDeckChanged(cb: () => void): Disposable;
}
