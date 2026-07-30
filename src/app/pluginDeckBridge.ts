import { findWorkspace, type Workspace } from "../domain/deck";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import type { createPluginManager } from "./pluginManager";
import type { Deck } from "./useDeck";

type Plugins = ReturnType<typeof createPluginManager>;
type WorkspaceRef = Pick<Workspace, "id" | "instance">;

export interface PluginDeckBridge {
  dispose(): void;
}

export function revealDockTabOn(
  deck: Pick<Deck, "activeId" | "viewOf" | "toggleDock" | "setDockTab">,
  tabId: string,
): void {
  if (!deck.activeId) return;
  if (!deck.viewOf(deck.activeId).dock) deck.toggleDock(deck.activeId);
  deck.setDockTab(deck.activeId, tabId);
}

/** Workspace lifetimes present before and gone now. */
export function closedWorkspaces(
  previous: readonly WorkspaceRef[],
  current: readonly WorkspaceRef[],
): WorkspaceRef[] {
  const now = new Set(current.map((workspace) => workspace.instance));
  return previous.filter((workspace) => !now.has(workspace.instance));
}

/** App-owned bridge between the deck store and plugin storage/UI/events. */
export function createPluginDeckBridge(
  deck: DeckStore,
  plugins: Plugins,
): PluginDeckBridge {
  const actions = createDeckActions(deck);
  let disposed = false;
  let previousWorkspaces: WorkspaceRef[] = [];
  let previousWorkspaceState: readonly Workspace[] | null = null;
  let selectionKey: string | null = null;

  plugins.wireDeckAccess({
    workspaces: () => deck.getSnapshot().workspaces,
    setPluginSlot: (wsId, workspaceInstance, pluginId, value) =>
      actions.setWorkspacePluginSlot(
        wsId,
        workspaceInstance,
        pluginId,
        value,
      ),
  });
  plugins.wireDeckUi({
    revealDockTab: (tabId) => {
      const state = deck.getSnapshot();
      if (!state.activeId) return;
      const view = state.viewByWs[state.activeId] ?? {};
      if (!view.dock) actions.toggleDock(state.activeId);
      actions.setDockTab(state.activeId, tabId);
    },
  });

  const reconcile = () => {
    if (disposed) return;
    const state = deck.getSnapshot();
    const current = state.workspaces.map(({ id, instance }) => ({
      id,
      instance,
    }));
    if (previousWorkspaceState !== state.workspaces) {
      for (const gone of closedWorkspaces(previousWorkspaces, current)) {
        plugins.pluginDeckEvents.emitWorkspaceClosed({ workspace: gone });
      }
      previousWorkspaces = current;
      previousWorkspaceState = state.workspaces;
      plugins.pluginDeckEvents.emitDeckChanged();
    }

    const active = findWorkspace(state.workspaces, state.activeId);
    const selectedPaneId = active
      ? (state.viewByWs[active.id]?.select ?? null)
      : null;
    const nextSelectionKey = active
      ? `${active.instance}\u0000${selectedPaneId ?? ""}`
      : "";
    if (selectionKey !== nextSelectionKey) {
      selectionKey = nextSelectionKey;
      if (active) {
        plugins.pluginDeckEvents.emitPaneSelected({
          workspace: { id: active.id, instance: active.instance },
          paneId: selectedPaneId,
        });
      }
    }
  };

  const unsubscribe = deck.subscribe(reconcile);
  reconcile();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      plugins.wireDeckAccess({
        workspaces: () => [],
        setPluginSlot: () => {},
      });
      plugins.wireDeckUi({ revealDockTab: () => {} });
    },
  };
}
