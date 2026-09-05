import {
  paneAgentType,
  paneBranch,
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
  type JournalSlice,
} from "../journal";
import {
  addAgentPane,
  closeAgent,
  findPane,
  findWorkspace,
  closeWorkspace,
  moveWorkspace,
  renameWorkspace,
  resolveActiveId,
  setWorkspacePluginSlot,
  workspaceIdsAreUnique,
  type Workspace,
} from "./workspaces";
// The pane transforms — one workspace list in, the next one out.
import {
  clearPaneIdle,
  failPaneWake,
  parkPane,
  renamePane,
  requestPaneWake,
  resetPaneLocation,
  resolvePaneProvisioning,
  setPaneAutoTitle,
  setPaneProvisioningError,
  setPaneSession,
  setPaneTeam,
  suspendPane,
} from "./panes";
import { paneExecutionCwd } from "./roots";
import type { DeckAction } from "./reducerActions";
import {
  hidePaneView,
  setViewField,
  withDefaultSelection,
  type WorkspaceView,
} from "./workspaceView";

export type { DeckAction } from "./reducerActions";
export type { WorkspaceView } from "./workspaceView";

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

export const initialDeckState: DeckState = {
  workspaces: [],
  activeId: "",
  viewByWs: {},
  journal: emptyJournal,
};

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
  const branch = paneBranch(pane);
  return {
    e: "bound",
    v: 1,
    wsId: ws.id,
    record: {
      agent: paneAgentType(pane),
      sessionId: session.id,
      // The journal attributes a session to a directory, and a session is
      // bound only once the pane has a process — so the formula never answers
      // null on this path. The workspace cwd stands in rather than widening
      // the journal schema to a nullable cwd for a branch that cannot run:
      // the record's readers want a string (the session search lower-cases
      // every field it has, the session list copies the cwd into its rows).
      // The directory-formula guard test names this line as its one allowance.
      cwd: paneExecutionCwd(ws, pane) ?? ws.cwd,
      ...(branch !== undefined && { branch }),
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
        const hidden = new Set([
          ...(view?.minimized ?? []),
          ...(view?.suspendedTray ?? []),
        ]);
        const firstLive = remaining.find((p) => !hidden.has(p.id));
        viewByWs = setViewField(viewByWs, wsId, "select", (firstLive ?? remaining[0])?.id);
      }
      // Drop the closed pane from the minimized set so it can't linger as a
      // stale chip/bar (the layout ignores stale ids at render, but the
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
      if (view?.suspendedTray?.includes(paneId)) {
        const next = view.suspendedTray.filter((id) => id !== paneId);
        viewByWs = setViewField(
          viewByWs,
          wsId,
          "suspendedTray",
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
      if (!isMinimized) {
        return withView(
          state,
          hidePaneView(
            state.viewByWs,
            state.workspaces,
            wsId,
            paneId,
            "minimized",
          ),
        );
      }
      const next = current.filter((id) => id !== paneId);
      let viewByWs = setViewField(
        state.viewByWs,
        wsId,
        "minimized",
        next.length > 0 ? next : undefined,
      );
      // Restoring: highlight it where it reappears on the grid, and exit any
      // maximize — a maximized OTHER pane would keep the restored one hidden
      // the moment its chip disappears (the addAgentPane guard's reason).
      viewByWs = setViewField(viewByWs, wsId, "select", paneId);
      viewByWs = setViewField(viewByWs, wsId, "focus", undefined);
      return withView(state, viewByWs);
    }
    case "restoreSuspendedPane": {
      const { wsId, paneId } = action;
      const view = state.viewByWs[wsId];
      const current = view?.suspendedTray;
      if (!current?.includes(paneId)) return state;
      const next = current.filter((id) => id !== paneId);
      let viewByWs = setViewField(
        state.viewByWs,
        wsId,
        "suspendedTray",
        next.length > 0 ? next : undefined,
      );
      // Manual minimize placement is independent and can coexist after a
      // Grid→List suspend. Do not strand selection on a pane that remains
      // hidden when Grid applies that marker.
      if (!view?.minimized?.includes(paneId)) {
        viewByWs = setViewField(viewByWs, wsId, "select", paneId);
        viewByWs = setViewField(viewByWs, wsId, "focus", undefined);
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
    case "setPaneTeam":
      // Same no-op contract. Whether the role was free is decided before the
      // dispatch — this rung only applies the answer.
      return withWorkspaces(
        state,
        setPaneTeam(state.workspaces, action.wsId, action.paneId, action.team),
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
    case "clearPaneIdle":
      // clearPaneIdle returns the same ref for an absent/already-live pane, so
      // a re-fired revive effect causes no re-render.
      return withWorkspaces(
        state,
        clearPaneIdle(state.workspaces, action.wsId, action.paneId),
      );
    case "suspendPane": {
      // suspendPane returns the same ref for a pane that is absent, already
      // idle or still provisioning — a repeated gesture re-renders nothing.
      const workspaces = suspendPane(
        state.workspaces,
        action.wsId,
        action.paneId,
        action.at,
      );
      if (workspaces === state.workspaces) return state;
      const next = { ...state, workspaces };
      return action.moveToTray
        ? withView(
            next,
            hidePaneView(
              next.viewByWs,
              next.workspaces,
              action.wsId,
              action.paneId,
              "suspendedTray",
            ),
          )
        : next;
    }
    case "requestPaneWake":
      return withWorkspaces(
        state,
        requestPaneWake(state.workspaces, action.wsId, action.paneId),
      );
    case "failPaneWake":
      return withWorkspaces(
        state,
        failPaneWake(state.workspaces, action.wsId, action.paneId),
      );
    case "parkPane":
      return withWorkspaces(
        state,
        parkPane(state.workspaces, action.wsId, action.paneId),
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
      // A same-id rebind leaves the PANE untouched — there is nothing to
      // change about it — but it is not a no-op for the JOURNAL. Boot demotes
      // every loaded `live` record to `closed`, and a restored pane resuming
      // its recorded session re-reports the SAME id; that re-report is the
      // only signal that the record is live again. Returning here on the
      // unchanged array skipped the `bound` below, so a running agent's row
      // stayed "Closed", dated at the boot instant, for the pane's whole life
      // — and `hydrateJournalSlice` documents the flip that never happened.
      const workspaces = setPaneSession(state.workspaces, wsId, paneId, session);
      if (!ws || !pane) return withWorkspaces(state, workspaces);
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
      // Identity is still preserved for a genuine no-op — clearing a pane that
      // is already clear touches neither side.
      if (workspaces === state.workspaces && journal === state.journal) {
        return state;
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
    case "journalFlushed": {
      const journal = flushJournalTail(state.journal, action.count);
      return journal === state.journal ? state : { ...state, journal };
    }
  }
}
