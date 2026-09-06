import {
  findPane,
  findTeam,
  findWorkspace,
  type DeckState,
  type Pane,
  type PaneSession,
  type Team,
  type TeamLocation,
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
    restoreSuspendedPane: (wsId: string, paneId: string) =>
      dispatch({ type: "restoreSuspendedPane", wsId, paneId }),
    selectPane: (wsId: string, paneId: string) =>
      dispatch({ type: "selectPane", wsId, paneId }),
    /** Drill into a team on the stage — from its card, a reveal, a door. */
    openTeam: (wsId: string, teamId: string) => dispatch({ type: "openTeam", wsId, teamId }),
    /** Back up to the workspace's team cards. */
    closeTeam: (wsId: string) => dispatch({ type: "closeTeam", wsId }),
    toggleDock: (wsId: string) => dispatch({ type: "toggleDock", wsId }),
    setDockTab: (wsId: string, tabId: string) =>
      dispatch({ type: "setDockTab", wsId, tabId }),
    renamePane: (wsId: string, paneId: string, name: string) =>
      dispatch({ type: "renamePane", wsId, paneId, name }),
    setPaneAutoTitle: (wsId: string, paneId: string, title: string) =>
      dispatch({ type: "setPaneAutoTitle", wsId, paneId, title }),
    /** Settle a team's roster — name and every member's role — as one
     * change: the one write the roster surfaces make. */
    settleRoster: (
      wsId: string,
      teamId: string,
      name: string,
      members: readonly { paneId: string; role: string }[],
    ) => dispatch({ type: "settleRoster", wsId, teamId, name, members }),
    hydrate: (state: DeckState) => dispatch({ type: "hydrate", state }),
    clearPaneIdle: (wsId: string, paneId: string) =>
      dispatch({ type: "clearPaneIdle", wsId, paneId }),
    suspendPane: (wsId: string, paneId: string, moveToTray = false) =>
      dispatch({
        type: "suspendPane",
        wsId,
        paneId,
        at: nowIso(),
        moveToTray,
      }),
    requestPaneWake: (wsId: string, paneId: string) =>
      dispatch({ type: "requestPaneWake", wsId, paneId }),
    failPaneWake: (wsId: string, paneId: string) =>
      dispatch({ type: "failPaneWake", wsId, paneId }),
    parkPane: (wsId: string, paneId: string) =>
      dispatch({ type: "parkPane", wsId, paneId }),
    resetPaneSession: (wsId: string, paneId: string) =>
      dispatch({ type: "resetPaneSession", wsId, paneId }),
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
    /** Is this team still in the deck? A read, like `hasPane`, for the
     * background create that outlives the render which started it. */
    hasTeam: (wsId: string, teamId: string): boolean => {
      const ws = findWorkspace(store.getSnapshot().workspaces, wsId);
      return !!ws && findTeam(ws, teamId) !== undefined;
    },
    createTeam: (wsId: string, team: Team & { location: TeamLocation }) =>
      dispatch({ type: "createTeam", wsId, team }),
    resolveTeamProvisioning: (
      wsId: string,
      teamId: string,
      worktree: { cwd: string; branch: string },
    ) =>
      dispatch({
        type: "resolveTeamProvisioning",
        wsId,
        teamId,
        cwd: worktree.cwd,
        branch: worktree.branch,
      }),
    setTeamProvisioningError: (wsId: string, teamId: string, error: string | null) =>
      dispatch({ type: "setTeamProvisioningError", wsId, teamId, error }),
    renameTeam: (wsId: string, teamId: string, name: string) =>
      dispatch({ type: "renameTeam", wsId, teamId, name }),
    joinTeam: (wsId: string, paneId: string, teamId: string, role: string) =>
      dispatch({ type: "joinTeam", wsId, paneId, teamId, role }),
    leaveTeam: (wsId: string, paneId: string) => dispatch({ type: "leaveTeam", wsId, paneId }),
    dissolveTeam: (wsId: string, teamId: string) =>
      dispatch({ type: "dissolveTeam", wsId, teamId }),
    hydrateJournal: (records: JournalRecords) =>
      dispatch({ type: "hydrateJournal", records, at: nowIso() }),
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
