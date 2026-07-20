import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  type DeckState,
  type Pane,
  type PaneSession,
  type Workspace,
  type WorkspaceView,
} from "../domain/deck";
import type { JournalRecords } from "../domain/journal";
import { createDeckStore, type DeckStore } from "./deckStore";
import { mintWorkspaceSeq } from "./ids";

/** An empty view — the defaults for a workspace with no view entry yet. Shared
 * so `viewOf` returns a stable reference for absent workspaces. */
const EMPTY_VIEW: WorkspaceView = {};

/** Journal events carry wall-clock stamps; the reducer stays deterministic by
 * taking them from the action, minted here at the dispatch boundary. */
const nowIso = () => new Date().toISOString();

/** The deck surface the application hooks drive (state + bound actions). */
export type Deck = ReturnType<typeof useDeck>;
export type WorkspaceCreationResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "sequence-exhausted" | "duplicate-id" };

/**
 * Owns the deck's reducer and exposes the state plus bound action helpers, so
 * `App` drives the deck through one well-typed surface instead of juggling four
 * coupled `useState`s and cleaning them by hand on every removal.
 */
export function useDeck() {
  const storeRef = useRef<DeckStore | null>(null);
  if (storeRef.current === null) storeRef.current = createDeckStore();
  const store = storeRef.current;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const dispatch = store.dispatch;
  // Stable because the minimize-mode effect depends on this command while it
  // reconciles the independently-owned settings and deck state.
  const clearMinimized = useCallback(
    () => dispatch({ type: "clearMinimized" }),
    [dispatch],
  );
  return {
    ...state,
    /** The workspace's view state (maximize, selection, dock, dock tab), or the
     * shared empty view when it has none yet — read through here so consumers
     * touch one selector, not the raw map shape. */
    viewOf: (wsId: string): WorkspaceView => state.viewByWs[wsId] ?? EMPTY_VIEW,
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
    clearMinimized,
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
    revivePane: (wsId: string, paneId: string) =>
      dispatch({ type: "revivePane", wsId, paneId }),
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
