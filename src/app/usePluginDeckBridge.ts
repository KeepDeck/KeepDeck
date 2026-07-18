import { useEffect, useRef } from "react";
import type { Workspace } from "../domain/deck";
import type { Deck } from "./useDeck";
import { useAppRuntime } from "./runtimeContext";

/**
 * The one place the React-owned deck and the app-owned plugin runtime
 * meet. Wires the deck accessors (workspace KV reads/writes) at mount, and
 * translates deck state transitions into plugin events by diffing renders —
 * no callsite in the app has to remember to fire anything.
 */
export function usePluginDeckBridge(deck: Deck): void {
  const { pluginDeckEvents, wireDeckAccess, wireDeckUi } =
    useAppRuntime().plugins;
  // The ref keeps the accessor pair pointed at the CURRENT render's deck;
  // wiring itself happens once.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  useEffect(() => {
    wireDeckAccess({
      workspaces: () => deckRef.current.workspaces,
      setPluginSlot: (wsId, workspaceInstance, pluginId, value) =>
        deckRef.current.setWorkspacePluginSlot(
          wsId,
          workspaceInstance,
          pluginId,
          value,
        ),
    });
    wireDeckUi({
      revealDockTab: (tabId) => revealDockTabOn(deckRef.current, tabId),
    });
  }, [wireDeckAccess, wireDeckUi]);

  // Workspace removals + the coarse change signal, from one diff.
  const previous = useRef<WorkspaceRef[]>([]);
  useEffect(() => {
    const current = deck.workspaces.map(({ id, instance }) => ({ id, instance }));
    for (const gone of closedWorkspaceIds(previous.current, current)) {
      pluginDeckEvents.emitWorkspaceClosed({ wsId: gone });
    }
    previous.current = current;
    pluginDeckEvents.emitDeckChanged();
  }, [deck.workspaces, pluginDeckEvents]);

  const selectedPaneId = deck.viewOf(deck.activeId).select ?? null;
  useEffect(() => {
    if (!deck.activeId) return;
    pluginDeckEvents.emitPaneSelected({
      wsId: deck.activeId,
      paneId: selectedPaneId,
    });
  }, [deck.activeId, selectedPaneId, pluginDeckEvents]);
}

/** Reveal a dock tab on the ACTIVE workspace — the host side of a plugin's
 * `ui.revealDockTab`: open the dock if it's closed (the deck action is a
 * toggle, so read the view first), then select the tab. No active workspace →
 * nothing to reveal into. */
export function revealDockTabOn(
  deck: Pick<Deck, "activeId" | "viewOf" | "toggleDock" | "setDockTab">,
  tabId: string,
): void {
  if (!deck.activeId) return;
  if (!deck.viewOf(deck.activeId).dock) deck.toggleDock(deck.activeId);
  deck.setDockTab(deck.activeId, tabId);
}

/** Workspace lifetimes present before and gone now. A reused public id with a
 * new instance still means the previous workspace closed. */
type WorkspaceRef = Pick<Workspace, "id" | "instance">;

export function closedWorkspaceIds(
  previous: readonly WorkspaceRef[],
  current: readonly WorkspaceRef[],
): string[] {
  const now = new Set(current.map((workspace) => workspace.instance));
  return previous
    .filter((workspace) => !now.has(workspace.instance))
    .map((workspace) => workspace.id);
}
