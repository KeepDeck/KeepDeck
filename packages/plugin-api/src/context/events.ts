import type { Disposable } from "./disposable.ts";

/**
 * Deck lifecycle events. Subscriptions auto-dispose with the plugin — a
 * deactivated plugin cannot leak a listener.
 */
export interface PluginEvents {
  /** A workspace is closing — stop anything that belongs to it. */
  onWorkspaceClosed(cb: (e: { wsId: string }) => void): Disposable;
  /** The highlighted pane changed in some workspace. */
  onPaneSelected(
    cb: (e: { wsId: string; paneId: string | null }) => void,
  ): Disposable;
  /** Coarse "the deck changed" signal for cheap re-reads. */
  onDeckChanged(cb: () => void): Disposable;
}
