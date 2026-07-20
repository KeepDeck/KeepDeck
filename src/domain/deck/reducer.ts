import {
  paneAgentType,
  paneFrozenTitle,
  resolveFocus,
  type Pane,
  type PaneSession,
} from "./panes";
import {
  emptyJournal,
  flushJournalTail,
  hydrateJournalSlice,
  withJournalEvent,
  type JournalEvent,
  type JournalRecords,
  type JournalSlice,
} from "../journal";
import {
  addAgentPane,
  closeAgent,
  findPane,
  findWorkspace,
  paneExecutionCwd,
  closeWorkspace,
  moveWorkspace,
  renamePane,
  renameWorkspace,
  resetPaneLocation,
  resolveActiveId,
  resolvePaneProvisioning,
  revivePane,
  setPaneAutoTitle,
  setPaneProvisioningError,
  setPaneProvisioningPhase,
  setPaneSession,
  setWorkspacePluginSlot,
  workspaceIdsAreUnique,
  type Workspace,
} from "./workspaces";
import type { WorkspaceInstance } from "../workspaceInstance";

/**
 * One workspace's runtime view state, in a SINGLE object per workspace so a
 * workspace's UI state has one home instead of being smeared across parallel
 * `*ByWs` maps. Sparse: an absent field means its default — no maximize, no
 * selection, dock closed, no tab picked. `focus`/`select` persist with the
 * deck; `dock`/`dockTab` are session-only (the codec never writes them, so
 * every launch starts with the dock closed on its default tab).
 */
export interface WorkspaceView {
  /** Maximized pane id, when one is maximized. Persisted. */
  focus?: string;
  /** Highlighted (selected) pane id. Persisted. */
  select?: string;
  /** Whether this workspace's dock is open. Session-only. */
  dock?: boolean;
  /** The selected dock tab id (`pluginId:entryId`). Session-only. */
  dockTab?: string;
  /** Pane ids minimized out of the grid (the tray/strip minimize styles).
   * Session-only, like dock/dockTab — persist.ts never writes it, so every
   * launch starts with nothing minimized. Kept only while non-empty. */
  minimized?: string[];
}

/**
 * The deck's interdependent state: the workspaces, which one is active, and the
 * per-workspace view state. Kept in one reducer so the close transitions clean
 * focus + selection atomically — the App's old hand-rolled "three setStates per
 * close" was the thing that, if one was missed, left the border or maximize
 * pointing at a removed pane ([S1]).
 */
export interface DeckState {
  workspaces: Workspace[];
  activeId: string;
  /** The workspace session journal ([F8]): folded records + the outbox of
   * events awaiting their `journal.jsonl` append. Maintained by the SAME
   * transitions that touch panes, so seal-on-close is atomic. Persisted in
   * its own document, never in deck.json. */
  journal: JournalSlice;
  /** Workspace ids that came from deck.json this run (runtime-only, never
   * persisted; absent = none restored). Journal hydration keeps a loaded key
   * ONLY for these: `ws-N` ids are reusable slots, and a workspace CREATED
   * this run must not adopt a crash-orphaned journal that raced its
   * `wsDeleted` prune (the guard no-ops before the journal is hydrated). */
  restoredWorkspaceIds?: ReadonlySet<string>;
  /** Per-workspace view state (maximize, selection, dock open, dock tab), one
   * entry per workspace (absent = all defaults). Replaces the old parallel
   * focusByWs/selectByWs/dockByWs maps: closing a workspace drops ONE entry,
   * and a new per-workspace concern is a field on `WorkspaceView`, not a new
   * top-level map. */
  viewByWs: Record<string, WorkspaceView>;
}

export type DeckAction =
  | { type: "selectWorkspace"; id: string }
  /** `at` guards against a reused `ws-N` id inheriting a crash-orphaned
   * journal key (it stamps the pruning event). */
  | { type: "createWorkspace"; workspace: Workspace; at: string }
  /** Append an already-formed agent pane (from the add-agent dialog). */
  | { type: "addAgentPane"; id: string; pane: Pane }
  | { type: "renameWorkspace"; id: string; name: string }
  /** Reorder the rail: move workspace `id` to `toIndex` (drag & drop). */
  | { type: "moveWorkspace"; id: string; toIndex: number }
  | { type: "closeAgent"; wsId: string; paneId: string; at: string }
  | { type: "closeWorkspace"; id: string; at: string }
  | { type: "toggleFocus"; wsId: string; paneId: string }
  /** Minimize a pane out of the grid, or restore it (the tray/strip styles). */
  | { type: "toggleMinimize"; wsId: string; paneId: string }
  /** Drop the session-only minimized set from every workspace view. */
  | { type: "clearMinimized" }
  | { type: "selectPane"; wsId: string; paneId: string }
  /** Flip a workspace's dock (the top bar's dock button). */
  | { type: "toggleDock"; wsId: string }
  /** Pick a workspace's dock tab — remembered per workspace, session-only. */
  | { type: "setDockTab"; wsId: string; tabId: string }
  /** Manual pane rename ([F11]); empty name reverts to auto/derived. */
  | { type: "renamePane"; wsId: string; paneId: string; name: string }
  /** Auto title from the terminal (OSC) for a pane ([F11]). */
  | { type: "setPaneAutoTitle"; wsId: string; paneId: string; title: string }
  /** Replace the whole deck with a restored one (app boot, [F7]). */
  | { type: "hydrate"; state: DeckState }
  /** Wake a dormant restored pane — its terminal mounts and spawns ([F7]). */
  | { type: "revivePane"; wsId: string; paneId: string }
  /** Detach a pane from a gone worktree (drops cwd/branch/session) so it can
   * start fresh in the workspace cwd ([F7] restore reconcile). */
  | { type: "resetPaneLocation"; wsId: string; paneId: string }
  /** Bind a live pane to its agent session — the resume key ([F7]/[F8]) —
   * or drop a dead binding (`null`). */
  | {
      type: "setPaneSession";
      wsId: string;
      paneId: string;
      session: PaneSession | null;
      /** The session's transcript file when the reporter delivered it —
       * journal-only data, never stored on the pane. */
      transcriptPath?: string;
      /** Stamp for the journal seal of the previous binding, if any. */
      at: string;
    }
  /** A background worktree create landed: pin the pane to it and mount its
   * terminal. */
  | {
      type: "resolvePaneProvisioning";
      wsId: string;
      paneId: string;
      cwd: string;
      branch: string;
    }
  /** Record why a pane's worktree create failed, or clear it (`null`) when a
   * Retry starts. */
  | {
      type: "setPaneProvisioningError";
      wsId: string;
      paneId: string;
      error: string | null;
    }
  /** The provisioning card's step: the worktree exists, setup is running. */
  | { type: "setPaneProvisioningPhase"; wsId: string; paneId: string; phase: "setup" }
  /** Set (or, via `undefined`, clear) one plugin's opaque persisted slot for
   * a workspace — the write path behind a plugin's workspace-scoped storage
   * (`ctx.storage.workspace(workspace)`). */
  | {
      type: "setWorkspacePluginSlot";
      wsId: string;
      workspaceInstance: WorkspaceInstance;
      pluginId: string;
      value: unknown;
    }
  /** Fold the loaded journal.jsonl in at boot (after the deck hydrated). */
  | { type: "hydrateJournal"; records: JournalRecords; at: string }
  /** Drop one journal row (the history list's ×) — metadata only, the agent
   * store is untouched. */
  | { type: "deleteJournalRecord"; wsId: string; sessionId: string; at: string }
  /** The persistence hook appended the first `count` tail events to disk. */
  | { type: "journalFlushed"; count: number };

export const initialDeckState: DeckState = {
  workspaces: [],
  activeId: "",
  viewByWs: {},
  journal: emptyJournal,
};

/** A workspace view with no set field is dropped from the map so `viewByWs`
 * stays sparse (an absent entry = all defaults), like the maps it replaced. */
function isEmptyView(view: WorkspaceView): boolean {
  return (
    view.focus === undefined &&
    view.select === undefined &&
    view.dock === undefined &&
    view.dockTab === undefined &&
    view.minimized === undefined
  );
}

/** Set (or, via `undefined`, clear) ONE field of a workspace's view. Prunes an
 * emptied view out of the map, and returns the SAME map reference when the
 * value is unchanged — so a no-op dispatch causes no re-render, exactly like
 * the old per-map dropKey/spread guards. Generic over a single key so the
 * assignment is type-checked (a `keyof` union would not be). */
function setViewField<K extends keyof WorkspaceView>(
  viewByWs: Record<string, WorkspaceView>,
  wsId: string,
  field: K,
  value: WorkspaceView[K] | undefined,
): Record<string, WorkspaceView> {
  const current = viewByWs[wsId];
  if ((current?.[field] ?? undefined) === value) return viewByWs;
  const next: WorkspaceView = { ...current };
  if (value === undefined) delete next[field];
  else next[field] = value;
  if (isEmptyView(next)) {
    const { [wsId]: _emptied, ...rest } = viewByWs;
    return rest;
  }
  return { ...viewByWs, [wsId]: next };
}

/** Default a workspace's selection to its first pane, only if it has none yet. */
function withDefaultSelection(
  viewByWs: Record<string, WorkspaceView>,
  wsId: string,
  ws: Workspace | undefined,
): Record<string, WorkspaceView> {
  const first = ws?.panes[0]?.id;
  if (viewByWs[wsId]?.select || !first) return viewByWs;
  return setViewField(viewByWs, wsId, "select", first);
}

/** The `bound` journal event for a pane's session — how a pane becomes a
 * journal record, in ONE place: both binding paths (a reporter postback via
 * `setPaneSession`, a resume-minted pane via `addAgentPane`) must record the
 * same shape, or a field added to the model silently goes missing on one. */
function boundEventFor(
  ws: Workspace,
  pane: Pane,
  session: PaneSession,
  transcriptPath?: string,
): JournalEvent {
  return {
    e: "bound",
    v: 1,
    wsId: ws.id,
    record: {
      agent: paneAgentType(pane),
      sessionId: session.id,
      cwd: paneExecutionCwd(ws, pane) ?? ws.cwd,
      ...(pane.branch !== undefined && { branch: pane.branch }),
      ...(pane.yolo && { yolo: true }),
      ...(transcriptPath !== undefined && { transcriptPath }),
      boundAt: session.boundAt,
      paneId: pane.id,
    },
  };
}

/** Rebuild deck state around a workspaces transform, but only when it actually
 * changed the array: a transform that returns the same ref (a no-op — a
 * same-value rebind, a repeated OSC title, a closed pane's late result) yields
 * the same state ref, so a re-fired effect causes no re-render. */
function withWorkspaces(state: DeckState, workspaces: Workspace[]): DeckState {
  return workspaces === state.workspaces ? state : { ...state, workspaces };
}

/** The view-map counterpart of [`withWorkspaces`]: a `setViewField` that
 * changed nothing (re-picking the current tab, re-selecting the current pane)
 * returns the same map ref → the same state ref → no re-render. */
function withView(
  state: DeckState,
  viewByWs: Record<string, WorkspaceView>,
): DeckState {
  return viewByWs === state.viewByWs ? state : { ...state, viewByWs };
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "selectWorkspace": {
      const ws = state.workspaces.find((w) => w.id === action.id);
      return {
        ...state,
        activeId: action.id,
        viewByWs: withDefaultSelection(state.viewByWs, action.id, ws),
      };
    }
    case "createWorkspace": {
      const { workspace } = action;
      // An id is one live-deck slot. Allocation normally prevents a duplicate,
      // but the state owner enforces the invariant too so imported/programmatic
      // actions cannot make selectors ambiguous or one close remove two rows.
      if (state.workspaces.some((ws) => ws.id === workspace.id)) return state;
      return {
        ...state,
        // A reused `ws-N` slot must not inherit a crash-orphaned journal key.
        journal: withJournalEvent(state.journal, {
          e: "wsDeleted",
          v: 1,
          wsId: workspace.id,
          at: action.at,
        }),
        workspaces: [...state.workspaces, workspace],
        activeId: workspace.id,
        viewByWs: withDefaultSelection(state.viewByWs, workspace.id, workspace),
      };
    }
    case "addAgentPane": {
      const workspaces = addAgentPane(state.workspaces, action.id, action.pane);
      // Only select it if it was actually appended (the cap wasn't hit).
      const appended = workspaces
        .find((w) => w.id === action.id)
        ?.panes.some((p) => p.id === action.pane.id);
      if (!appended) return { ...state, workspaces };
      // Select the appended pane, and exit any maximize so it isn't left
      // hidden and invisible behind the old maximized pane (resolveFocus
      // still points at the old pane) — the mirror of closeAgent's guard.
      let viewByWs = setViewField(state.viewByWs, action.id, "select", action.pane.id);
      viewByWs = setViewField(viewByWs, action.id, "focus", undefined);
      // A pane arriving WITH a session (journal resume) claims its record:
      // the reporter's later same-id re-report is a binding no-op, so this
      // is the transition that flips the row back to live.
      let journal = state.journal;
      const ws = findWorkspace(workspaces, action.id);
      if (ws && action.pane.session) {
        journal = withJournalEvent(
          journal,
          boundEventFor(ws, action.pane, action.pane.session),
        );
      }
      return { ...state, workspaces, viewByWs, journal };
    }
    case "renameWorkspace":
      return {
        ...state,
        workspaces: renameWorkspace(state.workspaces, action.id, action.name),
      };
    case "moveWorkspace":
      // moveWorkspace returns the same ref on a no-op move → skip the re-render.
      return withWorkspaces(
        state,
        moveWorkspace(state.workspaces, action.id, action.toIndex),
      );
    case "closeAgent": {
      const { wsId, paneId } = action;
      const panes = state.workspaces.find((w) => w.id === wsId)?.panes;
      const closing = panes?.find((p) => p.id === paneId);
      const remaining = panes?.filter((p) => p.id !== paneId) ?? [];
      const workspaces = closeAgent(state.workspaces, wsId, paneId);
      // Seal the pane's journal record in the SAME transition that removes
      // the pane — the row's title freezes to what the header showed.
      const journal = closing?.session
        ? withJournalEvent(state.journal, {
            e: "sealed",
            v: 1,
            wsId,
            sessionId: closing.session.id,
            title: paneFrozenTitle(closing),
            at: action.at,
          })
        : state.journal;
      const view = state.viewByWs[wsId];
      let viewByWs = state.viewByWs;
      // Drop the maximize unless it still RESOLVES over the survivors — not
      // only when the maximized pane itself was closed. A key left on a
      // now-solo workspace is masked (solo never maximizes) but springs back
      // on the NEXT added pane, rendering it hidden and invisible.
      if (view?.focus !== undefined && resolveFocus(remaining, view.focus) === null) {
        viewByWs = setViewField(viewByWs, wsId, "focus", undefined);
      }
      // Move the highlight off the closed pane — to the first VISIBLE
      // survivor when one exists (a minimized survivor can't usefully carry
      // the highlight), else the first survivor of any kind (correct for the
      // "none" style, where the minimized set is ignored and every pane
      // shows), or clear it when none remain.
      if (view?.select === paneId) {
        const minimized = view?.minimized ?? [];
        const firstLive = remaining.find((p) => !minimized.includes(p.id));
        viewByWs = setViewField(viewByWs, wsId, "select", (firstLive ?? remaining[0])?.id);
      }
      // Drop the closed pane from the minimized set so it can't linger as a
      // stale chip/bar (partitionPanes ignores stale ids at render, but the
      // stored set is kept tidy here, mirroring the focus/select cleanup).
      if (view?.minimized?.includes(paneId)) {
        const next = view.minimized.filter((id) => id !== paneId);
        viewByWs = setViewField(
          viewByWs,
          wsId,
          "minimized",
          next.length > 0 ? next : undefined,
        );
      }
      return { ...state, workspaces, viewByWs, journal };
    }
    case "closeWorkspace": {
      const workspaces = closeWorkspace(state.workspaces, action.id);
      const activeId = resolveActiveId(workspaces, state.activeId);
      // The whole view entry — focus, selection, dock, dock tab — goes with
      // the workspace in one drop.
      const { [action.id]: _closed, ...remainingViews } = state.viewByWs;
      const newActive = workspaces.find((w) => w.id === activeId);
      const viewByWs = withDefaultSelection(remainingViews, activeId, newActive);
      // The workspace's journal goes with it, in the same drop.
      const journal = withJournalEvent(state.journal, {
        e: "wsDeleted",
        v: 1,
        wsId: action.id,
        at: action.at,
      });
      // Spread, like every other case: this literal once dropped
      // `restoredWorkspaceIds`, and a close landing before the journal
      // hydrated then pruned EVERY restored workspace's history as orphaned.
      // The closed id leaves the restored set too — otherwise recreating
      // the same ws-N BEFORE the journal hydrates would count as "restored"
      // and adopt the dead workspace's history.
      const restoredWorkspaceIds = state.restoredWorkspaceIds?.has(action.id)
        ? new Set([...state.restoredWorkspaceIds].filter((id) => id !== action.id))
        : state.restoredWorkspaceIds;
      return { ...state, workspaces, activeId, viewByWs, journal, restoredWorkspaceIds };
    }
    case "toggleFocus": {
      const { wsId, paneId } = action;
      const current = state.viewByWs[wsId]?.focus;
      return withView(
        state,
        setViewField(state.viewByWs, wsId, "focus", current === paneId ? undefined : paneId),
      );
    }
    case "toggleMinimize": {
      const { wsId, paneId } = action;
      const view = state.viewByWs[wsId];
      const current = view?.minimized ?? [];
      const isMinimized = current.includes(paneId);
      const next = isMinimized
        ? current.filter((id) => id !== paneId)
        : [...current, paneId];
      let viewByWs = setViewField(
        state.viewByWs,
        wsId,
        "minimized",
        next.length > 0 ? next : undefined,
      );
      if (isMinimized) {
        // Restoring: highlight it where it reappears on the grid, and exit any
        // maximize — a maximized OTHER pane would keep the restored one hidden
        // the moment its chip disappears (the addAgentPane guard's reason).
        viewByWs = setViewField(viewByWs, wsId, "select", paneId);
        viewByWs = setViewField(viewByWs, wsId, "focus", undefined);
      } else {
        // Minimizing the maximized pane: nothing left to spotlight over, and a
        // lingering focus would spring back onto a hidden pane when restored.
        if (view?.focus === paneId) {
          viewByWs = setViewField(viewByWs, wsId, "focus", undefined);
        }
        // The minimize click selects its own pane first (the header's
        // mousedown), so the selection would stay stranded on the now-hidden
        // pane — ⌘W and the maximize hotkey would target an invisible agent.
        // Move it to the first still-visible pane, like closeAgent does.
        const selected = view?.select;
        if (selected !== undefined && next.includes(selected)) {
          const ws = state.workspaces.find((w) => w.id === wsId);
          const firstLive = ws?.panes.find((p) => !next.includes(p.id))?.id;
          viewByWs = setViewField(viewByWs, wsId, "select", firstLive);
        }
      }
      return withView(state, viewByWs);
    }
    case "clearMinimized": {
      let viewByWs = state.viewByWs;
      for (const wsId of Object.keys(viewByWs)) {
        viewByWs = setViewField(viewByWs, wsId, "minimized", undefined);
      }
      return withView(state, viewByWs);
    }
    case "selectPane":
      return withView(
        state,
        setViewField(state.viewByWs, action.wsId, "select", action.paneId),
      );
    case "toggleDock": {
      const open = state.viewByWs[action.wsId]?.dock ?? false;
      return withView(
        state,
        setViewField(state.viewByWs, action.wsId, "dock", open ? undefined : true),
      );
    }
    case "setDockTab":
      return withView(
        state,
        setViewField(state.viewByWs, action.wsId, "dockTab", action.tabId),
      );
    case "renamePane":
      return {
        ...state,
        workspaces: renamePane(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.name,
        ),
      };
    case "setPaneAutoTitle":
      // The helper is a no-op (same array ref) for an unchanged/absent pane.
      return withWorkspaces(
        state,
        setPaneAutoTitle(state.workspaces, action.wsId, action.paneId, action.title),
      );
    case "hydrate":
      // deck.json knows nothing of the journal — keep the live slice (its
      // own hydration is the separate `hydrateJournal`, sequenced after) and
      // remember WHICH ids the restore brought: only those may adopt loaded
      // journal keys (a this-run workspace reusing a `ws-N` slot must not).
      return workspaceIdsAreUnique(action.state.workspaces)
        ? {
            ...action.state,
            journal: state.journal,
            restoredWorkspaceIds: new Set(
              action.state.workspaces.map((w) => w.id),
            ),
          }
        : state;
    case "revivePane":
      // revivePane returns the same ref for an absent/already-live pane, so a
      // re-fired revive effect causes no re-render.
      return withWorkspaces(
        state,
        revivePane(state.workspaces, action.wsId, action.paneId),
      );
    case "resetPaneLocation":
      return withWorkspaces(
        state,
        resetPaneLocation(state.workspaces, action.wsId, action.paneId),
      );
    case "setPaneSession": {
      const { wsId, paneId, session } = action;
      const ws = findWorkspace(state.workspaces, wsId);
      const pane = ws && findPane(state.workspaces, wsId, paneId);
      // Same-id rebinds return the same ref — binding refreshes are no-ops,
      // for the journal too.
      const workspaces = setPaneSession(state.workspaces, wsId, paneId, session);
      if (workspaces === state.workspaces || !ws || !pane) {
        return withWorkspaces(state, workspaces);
      }
      let journal = state.journal;
      const prev = pane.session;
      if (prev && prev.id !== session?.id) {
        // The pane moved on (/clear, /new, start-new) — its old session is
        // history now, titled as the header showed at the switch.
        journal = withJournalEvent(journal, {
          e: "sealed",
          v: 1,
          wsId,
          sessionId: prev.id,
          title: paneFrozenTitle(pane),
          at: action.at,
        });
      }
      if (session) {
        journal = withJournalEvent(
          journal,
          boundEventFor(ws, pane, session, action.transcriptPath),
        );
      }
      return { ...state, workspaces, journal };
    }
    case "resolvePaneProvisioning":
      // Same ref when the pane was closed mid-create — the late result of a
      // background create must not resurrect anything.
      return withWorkspaces(
        state,
        resolvePaneProvisioning(state.workspaces, action.wsId, action.paneId, {
          cwd: action.cwd,
          branch: action.branch,
        }),
      );
    case "setPaneProvisioningError":
      return withWorkspaces(
        state,
        setPaneProvisioningError(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.error,
        ),
      );
    case "setPaneProvisioningPhase":
      return withWorkspaces(
        state,
        setPaneProvisioningPhase(
          state.workspaces,
          action.wsId,
          action.paneId,
          action.phase,
        ),
      );
    case "setWorkspacePluginSlot":
      if (
        state.workspaces.find((workspace) => workspace.id === action.wsId)
          ?.instance !== action.workspaceInstance
      ) {
        return state;
      }
      return withWorkspaces(
        state,
        setWorkspacePluginSlot(
          state.workspaces,
          action.wsId,
          action.pluginId,
          action.value,
        ),
      );
    case "hydrateJournal": {
      // A loaded key survives only for a workspace that is BOTH live and
      // restored-from-disk: a this-run creation reusing a `ws-N` id gets a
      // clean journal, whatever a crashed run left in the file.
      const restored = state.restoredWorkspaceIds ?? new Set<string>();
      const keepWsIds = new Set(
        state.workspaces.map((w) => w.id).filter((id) => restored.has(id)),
      );
      return {
        ...state,
        journal: hydrateJournalSlice(
          state.journal,
          action.records,
          keepWsIds,
          action.at,
        ),
      };
    }
    case "deleteJournalRecord": {
      const journal = withJournalEvent(state.journal, {
        e: "deleted",
        v: 1,
        wsId: action.wsId,
        sessionId: action.sessionId,
        at: action.at,
      });
      return journal === state.journal ? state : { ...state, journal };
    }
    case "journalFlushed": {
      const journal = flushJournalTail(state.journal, action.count);
      return journal === state.journal ? state : { ...state, journal };
    }
  }
}
