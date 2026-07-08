import { useEffect, useRef } from "react";
import type { Deck } from "./useDeck";
import { pluginDeckEvents, wireDeckAccess } from "./pluginManager";

/**
 * The one place the React-owned deck and the module-level plugin system
 * meet. Wires the deck accessors (workspace KV reads/writes) at mount, and
 * translates deck state transitions into plugin events by diffing renders —
 * no callsite in the app has to remember to fire anything.
 */
export function usePluginDeckBridge(deck: Deck): void {
  // The ref keeps the accessor pair pointed at the CURRENT render's deck;
  // wiring itself happens once.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  useEffect(() => {
    wireDeckAccess({
      workspaces: () => deckRef.current.workspaces,
      setPluginSlot: (wsId, pluginId, value) =>
        deckRef.current.setWorkspacePluginSlot(wsId, pluginId, value),
    });
  }, []);

  // Workspace removals + the coarse change signal, from one diff.
  const prevIds = useRef<string[]>([]);
  useEffect(() => {
    const ids = deck.workspaces.map((ws) => ws.id);
    for (const gone of closedWorkspaceIds(prevIds.current, ids)) {
      pluginDeckEvents.emitWorkspaceClosed({ wsId: gone });
    }
    prevIds.current = ids;
    pluginDeckEvents.emitDeckChanged();
  }, [deck.workspaces]);

  const selectedPaneId = deck.viewOf(deck.activeId).select ?? null;
  useEffect(() => {
    if (!deck.activeId) return;
    pluginDeckEvents.emitPaneSelected({
      wsId: deck.activeId,
      paneId: selectedPaneId,
    });
  }, [deck.activeId, selectedPaneId]);
}

/** Ids present before and gone now — the workspaces that just closed. */
export function closedWorkspaceIds(
  previous: readonly string[],
  current: readonly string[],
): string[] {
  const now = new Set(current);
  return previous.filter((id) => !now.has(id));
}
