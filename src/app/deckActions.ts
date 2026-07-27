import {
  findPane,
  type DeckState,
  type Pane,
  type PaneSession,
  type Workspace,
} from "../domain/deck";
import type { JournalRecords } from "../domain/journal";
import type { DeckStore } from "./deckStore";
import { mintWorkspaceSeq } from "./ids";

/**
 * Every transition the app can ask of the deck, bound to one store.
 *
 * Plain functions over `dispatch`, deliberately outside React: they carry no
 * view state and nothing about them needs a render, while the code that drives
 * pane lifecycles has to reach them whether or not anything is mounted. The
 * hook adds the subscription; this adds nothing but names.
 *
 * One set per store, so every action is referentially stable — effects may
 * depend on them without a memo of their own. Cached rather than merely
 * documented: the deck has two long-lived callers (the orchestrator and the
 * hook), and the moment an action carries per-instance state — a debounce, a
 * batching buffer — two sets would silently be two behaviours.
 */
export type DeckActions = ReturnType<typeof buildDeckActions>;

export type WorkspaceCreationResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "sequence-exhausted" | "duplicate-id" };

/** Journal events carry wall-clock stamps; the reducer stays deterministic by
 * taking them from the action, minted here at the dispatch boundary. */
const nowIso = () => new Date().toISOString();

const byStore = new WeakMap<DeckStore, DeckActions>();

export function createDeckActions(store: DeckStore): DeckActions {
  const existing = byStore.get(store);
  if (existing) return existing;
  const actions = buildDeckActions(store);
  byStore.set(store, actions);
  return actions;
}

function buildDeckActions(store: DeckStore) {
  const dispatch = store.dispatch;
  return {
    /** Is this pane still in the deck? A read, not a transition — background
     * work that outlives the render which started it needs to know whether the
     * pane it is working for is still there, and a no-op dispatch cannot say
     * so. Live against the store, like every action here. */
    hasPane: (wsId: string, paneId: string): boolean =>
      !!findPane(store.getSnapshot().workspaces, wsId, paneId),
    selectWorkspace: (id: string) => dispatch({ type: "selectWorkspace", id }),
    createWorkspace: (workspace: Workspace) =>
      dispatch({ type: "createWorkspace", workspace, at: nowIso() }),
    /** Build and insert a workspace against the latest deck snapshot.
     * Allocation and insertion are one synchronous state-owner operation, so
     * two creates in one React batch cannot observe or append the same id. */
    createWorkspaceFromSequence: (
      build: (sequence: number) => Workspace,
    ): WorkspaceCreationResult => {
      const sequence = mintWorkspaceSeq(
        store.getSnapshot().workspaces.map((workspace) => workspace.id),
      );
      if (sequence === null) {
        return { ok: false, reason: "sequence-exhausted" };
      }
      const workspace = build(sequence);
      const before = store.getSnapshot();
      const next = dispatch({ type: "createWorkspace", workspace, at: nowIso() });
      return next === before
        ? { ok: false, reason: "duplicate-id" }
        : { ok: true, workspace };
    },
    addAgentPane: (id: string, pane: Pane) =>
      dispatch({ type: "addAgentPane", id, pane }),
    renameWorkspace: (id: string, name: string) =>
      dispatch({ type: "renameWorkspace", id, name }),
    moveWorkspace: (id: string, toIndex: number) =>
      dispatch({ type: "moveWorkspace", id, toIndex }),
    closeAgent: (wsId: string, paneId: string) =>
      dispatch({ type: "closeAgent", wsId, paneId, at: nowIso() }),
    closeWorkspace: (id: string) =>
      dispatch({ type: "closeWorkspace", id, at: nowIso() }),
    toggleFocus: (wsId: string, paneId: string) =>
      dispatch({ type: "toggleFocus", wsId, paneId }),
    toggleMinimize: (wsId: string, paneId: string) =>
      dispatch({ type: "toggleMinimize", wsId, paneId }),
    clearMinimized: () => dispatch({ type: "clearMinimized" }),
    selectPane: (wsId: string, paneId: string) =>
      dispatch({ type: "selectPane", wsId, paneId }),
    toggleDock: (wsId: string) => dispatch({ type: "toggleDock", wsId }),
    setDockTab: (wsId: string, tabId: string) =>
      dispatch({ type: "setDockTab", wsId, tabId }),
    renamePane: (wsId: string, paneId: string, name: string) =>
      dispatch({ type: "renamePane", wsId, paneId, name }),
    setPaneAutoTitle: (wsId: string, paneId: string, title: string) =>
      dispatch({ type: "setPaneAutoTitle", wsId, paneId, title }),
    hydrate: (state: DeckState) => dispatch({ type: "hydrate", state }),
    clearPaneIdle: (wsId: string, paneId: string) =>
      dispatch({ type: "clearPaneIdle", wsId, paneId }),
    suspendPane: (wsId: string, paneId: string) =>
      dispatch({ type: "suspendPane", wsId, paneId, at: nowIso() }),
    requestPaneWake: (wsId: string, paneId: string) =>
      dispatch({ type: "requestPaneWake", wsId, paneId }),
    failPaneWake: (wsId: string, paneId: string) =>
      dispatch({ type: "failPaneWake", wsId, paneId }),
    parkPane: (wsId: string, paneId: string) =>
      dispatch({ type: "parkPane", wsId, paneId }),
    resetPaneLocation: (wsId: string, paneId: string) =>
      dispatch({ type: "resetPaneLocation", wsId, paneId }),
    setPaneSession: (
      wsId: string,
      paneId: string,
      session: PaneSession | null,
      transcriptPath?: string,
    ) =>
      dispatch({
        type: "setPaneSession",
        wsId,
        paneId,
        session,
        ...(transcriptPath !== undefined && { transcriptPath }),
        at: nowIso(),
      }),
    resolvePaneProvisioning: (
      wsId: string,
      paneId: string,
      worktree: { cwd: string; branch: string },
    ) =>
      dispatch({
        type: "resolvePaneProvisioning",
        wsId,
        paneId,
        cwd: worktree.cwd,
        branch: worktree.branch,
      }),
    setPaneProvisioningError: (wsId: string, paneId: string, error: string | null) =>
      dispatch({ type: "setPaneProvisioningError", wsId, paneId, error }),
    setPaneProvisioningPhase: (wsId: string, paneId: string, phase: "setup") =>
      dispatch({ type: "setPaneProvisioningPhase", wsId, paneId, phase }),
    hydrateJournal: (records: JournalRecords) =>
      dispatch({ type: "hydrateJournal", records, at: nowIso() }),
    deleteJournalRecord: (wsId: string, sessionId: string) =>
      dispatch({ type: "deleteJournalRecord", wsId, sessionId, at: nowIso() }),
    journalFlushed: (count: number) => dispatch({ type: "journalFlushed", count }),
    setWorkspacePluginSlot: (
      wsId: string,
      workspaceInstance: Workspace["instance"],
      pluginId: string,
      value: unknown,
    ) =>
      dispatch({
        type: "setWorkspacePluginSlot",
        wsId,
        workspaceInstance,
        pluginId,
        value,
      }),
  };
}
