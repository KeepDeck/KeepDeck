import { useRef, useState } from "react";
import {
  type AgentDialogResult,
  type AgentInfo,
  type AgentType,
  forkTargetFor,
  type SessionPickRow,
} from "../domain/agents";
import {
  baseName,
  findWorkspaceByRef,
  firstFreeWorktree,
  paneFromAgentRequest,
  paneId,
  parentDir,
  sessionClaimant,
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  type Workspace,
} from "../domain/deck";
import { handleFromHit } from "../domain/journal";
import { describeError } from "../ipc/log";
import { indexSearch } from "../ipc/history";
import type { Page } from "./usePagedSessionSearch";
import { inspectRepo, probeWorktree, suggestWorktree } from "../ipc/worktree";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { mintAgentSeq } from "./ids";
import { getSettings } from "./settingsManager";
import {
  firstFreeAgentWorktree,
  nextAgentIndex,
  nextAgentType,
} from "./newAgentDefaults";
import { useAppRuntime } from "./runtimeContext";
import type { Deck } from "./useDeck";

/** Where a "Start from" continuation reports its failure. A continuation the
 * user asked for must fail VISIBLY — a dialog that just closes reads as
 * success — and confirm is synchronous, so the notice is a callback rather
 * than a rejected promise the caller would have to remember to catch. */
export interface AgentDialogNotices {
  onResumeFailed(message: string): void;
  onForkFailed(message: string): void;
  /** The workspace refused the pane — it filled up, or it is gone. The
   * dialog has already closed by then, so without this the agent the user
   * asked for simply never appears. */
  onCreateFailed(message: string): void;
}

/** Everything the "+ Agent" dialog needs to render, captured at open time. */
export interface AgentDialogSpec {
  workspace: WorkspaceRef;
  agentId: string;
  index: number;
  defaultAgentType: AgentType;
  /** The YOLO toggle's starting position ([F6] global preference). */
  defaultYolo: boolean;
  /** Whether the Experimental “Remote agents” setting is on — gates the
   *  dialog's "Where: Remote" option regardless of an agent's capability. */
  remoteEnabled: boolean;
  /** The workspace repo when its cwd is a git repo — enables the worktree
   * location field; null → the agent just runs in the workspace cwd. */
  repo: { cwd: string; branch: string | null } | null;
  /** Prefilled worktree path — non-empty only when the workspace has a base
   * folder ([F2]: suggest a default only then). */
  suggestedPath: string;
  /** Prefilled branch for a new worktree. */
  suggestedBranch: string;
}

/**
 * Owns the "+ Agent" flow: open the dialog with per-workspace suggestions,
 * then turn its result into a pane — bare (main repo), attached to an existing
 * worktree, or a fresh worktree created at the chosen path ([F2]). The fresh
 * worktree lands optimistically: the pane joins the grid as a provisioning
 * card at once and the create runs in the background.
 */
export function useAgentDialog(
  deck: Deck,
  agents: AgentInfo[],
  /** Where a "Start from" continuation reports its failure. Explicit rather
   * than optional: an optional here is what forced the argument below to
   * carry a default, and that default is the bug it exists to prevent. */
  notices: AgentDialogNotices,
  /** paneId → the missing directory, from the revive sweep. A pane stuck on a
   * gone folder is going nowhere, so the picker must call its session stopped
   * like the tile and the tray already do — the model alone still reads that
   * pane as rising.
   *
   * REQUIRED, like `paneSuspendBlock`'s: a default is how the next surface
   * omits it, compiles, and tells the user a dead pane is running again. */
  blockedPanes: Record<string, string>,
) {
  const { orchestrator } = useAppRuntime();
  const [dialog, setDialog] = useState<AgentDialogSpec | null>(null);
  const deckRef = useRef(deck);
  deckRef.current = deck;

  /** Per-index name suggestion for `ws`, IPC failures flattened to null. */
  const suggestFor = (ws: Workspace) => (index: number) =>
    suggestWorktree(ws.name, index).catch(() => null);

  /** Disk probe for suggestion filtering, IPC failures flattened to null
   * (= don't filter — the dialog's live hint still guards the create). */
  const probeFor = (path: string) => probeWorktree(path).catch(() => null);

  const openFor = async (ws: Workspace) => {
    const workspace = { id: ws.id, instance: ws.instance };
    const seq = mintAgentSeq();
    const index = nextAgentIndex(ws);
    const defaultType = nextAgentType(agents, ws);
    // Offer the worktree location only when the workspace cwd is a git repo.
    const info = await inspectRepo(ws.cwd).catch(() => null);
    const repo = info?.isRepo ? { cwd: ws.cwd, branch: info.branch } : null;
    let suggestedPath = "";
    let suggestedBranch = "";
    if (repo) {
      if (ws.worktreeBaseDir) {
        // [F2]: prefill a path ONLY when the workspace has a base folder, so
        // the dialog opens on the first usable suggestion rather than onto an
        // occupied- or blocked-path error.
        const free = await firstFreeAgentWorktree(
          deckRef.current.workspaces,
          ws,
          index,
        );
        if (free) {
          suggestedPath = free.path;
          suggestedBranch = free.branch;
        }
      } else {
        // No base folder → start empty (= main repo), but still suggest a
        // branch for when the user picks a path by hand.
        const s = await suggestFor(ws)(index);
        if (s) suggestedBranch = s.branch;
      }
    }
    // The workspace may have closed while repo/path IPC was in flight. Its
    // public id can already name a replacement, so only the exact lifetime is
    // allowed to open this dialog.
    if (!findWorkspaceByRef(deckRef.current.workspaces, workspace)) return;
    setDialog({
      workspace,
      agentId: paneId(seq),
      index,
      defaultAgentType: defaultType,
      defaultYolo: getSettings()?.defaultYolo ?? false,
      remoteEnabled: getSettings()?.remoteAgents === true,
      repo,
      suggestedPath,
      suggestedBranch,
    });
  };

  const confirm = (result: AgentDialogResult) => {
    const { name, location, yolo, session } = result;
    const dlg = dialog;
    if (!dlg) return;
    setDialog(null);
    const currentDeck = deckRef.current;
    const ws = findWorkspaceByRef(currentDeck.workspaces, dlg.workspace);
    if (!ws) {
      // The workspace this dialog opened for is gone. Say so here rather than
      // returning quietly: the dialog has already closed, so silence is an
      // agent the user asked for that simply never appears. The landing would
      // refuse it too, but this path never reaches the landing.
      notices.onCreateFailed(WORKSPACE_GONE_MESSAGE);
      return;
    }
    const paneName = name.trim() || undefined;
    // "Start from" a picked session: a continuation, not a fresh pane. The
    // orchestrator owns plan-building, the claim re-check and (for a new
    // worktree) the provisioning. Resume ignores the location by design: the
    // session runs where it was recorded.
    if (session) {
      if (session.mode === "resume") {
        void orchestrator
          .resumeSession(dlg.workspace.id, session.handle, {
            name: paneName,
            yolo,
          })
          .catch((e: unknown) => notices.onResumeFailed(describeError(e)));
        return;
      }
      void orchestrator
        .forkSession(dlg.workspace.id, session.handle, forkTargetFor(location, ws.cwd), {
          name: paneName,
          yolo,
          ...(location.kind === "existing" &&
            location.branch && { branch: location.branch }),
        })
        .catch((e: unknown) => notices.onForkFailed(describeError(e)));
      return;
    }
    // A fresh conversation: the pane the request describes, handed to the one
    // owner of what arriving in a workspace entails. Whether it lands as a
    // terminal or as a provisioning card is the pane's shape to say, not this
    // surface's to arrange.
    const landed = orchestrator.createPane({
      workspace: dlg.workspace,
      pane: paneFromAgentRequest(dlg.agentId, result, ws, dlg.index),
    });
    // `gone` is reachable here too: the guard above reads this render's deck,
    // the landing re-resolves against the live store, and a workspace can
    // close in between.
    if (landed.kind === "full") notices.onCreateFailed(WORKSPACE_FULL_MESSAGE);
    else if (landed.kind === "gone") {
      notices.onCreateFailed(WORKSPACE_GONE_MESSAGE);
    }
  };

  /**
   * The next suggested location not held by an open pane (nor blocked on
   * disk) — the dialog's "Use next available" action for an occupied or
   * blocked path. Suggests inside the workspace base folder when set, else
   * right next to the unusable path; null when neither gives a base (or
   * suggestions fail).
   */
  const nextFree = async (currentPath: string) => {
    const dlg = dialog;
    if (!dlg) return null;
    const currentDeck = deckRef.current;
    const ws = findWorkspaceByRef(currentDeck.workspaces, dlg.workspace);
    if (!ws) return null;
    const base = ws.worktreeBaseDir ?? parentDir(currentPath);
    if (!base) return null;
    const free = await firstFreeWorktree(
      currentDeck.workspaces,
      base,
      suggestFor(ws),
      dlg.index,
      probeFor,
    );
    return findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace)
      ? free
      : null;
  };

  /**
   * The branch a worktree path implies — the dialog's live branch suggestion,
   * so the branch follows the worktree name until the user edits it. The
   * canonical branch when the folder matches this workspace's own naming
   * (`kd-<ws>-<n>` ↔ `kd/<ws>/<n>` — matched via the suggest IPC, the single
   * source of the scheme, not a TS re-implementation), else the folder name
   * verbatim (the backend sanitizes an explicit branch at create time). Null
   * when the path yields no usable name.
   */
  const branchFor = async (path: string): Promise<string | null> => {
    const dlg = dialog;
    if (!dlg) return null;
    const ws = findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace);
    if (!ws) return null;
    const folder = baseName(path);
    if (!folder) return null;
    const tail = /-(\d+)$/.exec(folder);
    if (tail) {
      const s = await suggestFor(ws)(Number(tail[1]));
      if (!findWorkspaceByRef(deckRef.current.workspaces, dlg.workspace))
        return null;
      if (s?.folder === folder) return s.branch;
    }
    return folder;
  };

  /**
   * The "Start from" picker's paged option source: one agent's sessions from
   * the search index, newest first (an empty query) or content/title-matched
   * (FTS — the same engine as the global browser). The dialog drives paging
   * through the shared engine ([[usePagedSessionSearch]]); this maps one page
   * of hits into pick rows and forwards the full match count.
   */
  const searchSessions = async (
    agent: AgentType,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<SessionPickRow>> => {
    const page = await indexSearch(query, limit, offset, agent);
    return {
      rows: page.hits.map((hit) => ({
        handle: handleFromHit(hit),
        mtime: hit.mtime,
        forkedAt: hit.forkedAt,
      })),
      total: page.total,
    };
  };

  /** How a session is already held by a pane: running behind a live PTY,
   * stopped (idle — restored, parked or suspended), or not at all — the picker
   * dims claimed rows for resume with the honest wording. */
  const sessionClaim = (sessionId: string): "running" | "stopped" | null =>
    sessionClaimant(
      deckRef.current.workspaces,
      sessionId,
      (paneId) => paneId in blockedPanes,
    )?.reads ?? null;

  const cancel = () => setDialog(null);

  return {
    dialog,
    openFor,
    confirm,
    cancel,
    nextFree,
    branchFor,
    searchSessions,
    sessionClaim,
  };
}
