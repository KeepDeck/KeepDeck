import { useRef, useState } from "react";
import {
  defaultAgentType,
  type AgentDialogResult,
  type AgentInfo,
  type AgentType,
  type SessionPickRow,
} from "../domain/agents";
import {
  baseName,
  findWorkspaceByRef,
  firstFreeWorktree,
  paneId,
  parentDir,
  type Pane,
  type Workspace,
} from "../domain/deck";
import { handleFromHit, type SessionHandle } from "../domain/journal";
import { indexSearch } from "../ipc/history";
import type { Page } from "./usePagedSessionSearch";
import { inspectRepo, probeWorktree, suggestWorktree } from "../ipc/worktree";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { mintAgentSeq } from "./ids";
import { getSettings } from "./settingsManager";
import { provisionInto, runProvisioning } from "./provisioning";
import type { Deck } from "./useDeck";
import type { ForkTarget } from "./useJournalFork";

/** The continuation flows the dialog's "Start from" choice routes into —
 * injected by App with its error surfacing already attached, so confirm
 * stays synchronous here. */
export interface AgentDialogJournalRouting {
  resume(wsId: string, handle: SessionHandle, opts: { name?: string; yolo?: boolean }): void;
  fork(
    wsId: string,
    handle: SessionHandle,
    target: ForkTarget,
    opts: { name?: string; branch?: string; yolo?: boolean },
  ): void;
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
  journal?: AgentDialogJournalRouting,
) {
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
    const index = ws.panes.length + 1;
    // Default the type to the last pane's if it's still selectable — the
    // workspace's own momentum beats the global preference ([F6]) — else the
    // preference (a snapshot read is right: the value matters at open time),
    // else the first installed agent ([F1]).
    const defaultType = defaultAgentType(
      agents,
      ws.panes[ws.panes.length - 1]?.agentType ??
        getSettings()?.defaultAgent ??
        "claude",
    );
    // Offer the worktree location only when the workspace cwd is a git repo.
    const info = await inspectRepo(ws.cwd).catch(() => null);
    const repo = info?.isRepo ? { cwd: ws.cwd, branch: info.branch } : null;
    let suggestedPath = "";
    let suggestedBranch = "";
    if (repo) {
      if (ws.worktreeBaseDir) {
        // [F2]: prefill a path ONLY when the workspace has a base folder —
        // and never a dir an open pane already runs in, nor one blocked on
        // disk: jump straight to the first usable suggestion instead of
        // opening onto an occupied- or blocked-path error.
        const free = await firstFreeWorktree(
          deckRef.current.workspaces,
          ws.worktreeBaseDir,
          suggestFor(ws),
          index,
          probeFor,
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

  const confirm = ({
    agentType,
    name,
    location,
    yolo,
    remoteEndpoint,
    session,
  }: AgentDialogResult) => {
    const dlg = dialog;
    if (!dlg) return;
    setDialog(null);
    const currentDeck = deckRef.current;
    const ws = findWorkspaceByRef(currentDeck.workspaces, dlg.workspace);
    if (!ws) return;
    const paneName = name.trim() || undefined;
    // "Start from" a picked session: hand off to the journal flows — they
    // own plan-building, claim re-checks and (for a new worktree)
    // provisioning. Resume ignores the location by design: the session runs
    // where it was recorded.
    if (session && journal) {
      if (session.mode === "resume") {
        journal.resume(dlg.workspace.id, session.handle, {
          name: paneName,
          yolo,
        });
        return;
      }
      const target: ForkTarget =
        location.kind === "new"
          ? {
              kind: "worktree",
              path: location.path,
              branch: location.branch,
              ...(location.baseBranch && { base: location.baseBranch }),
            }
          : location.kind === "existing"
            ? { kind: "dir", cwd: location.path }
            : { kind: "dir", cwd: ws.cwd };
      journal.fork(dlg.workspace.id, session.handle, target, {
        name: paneName,
        yolo,
        ...(location.kind === "existing" &&
          location.branch && { branch: location.branch }),
      });
      return;
    }
    // Sparse like persistence: only the armed mode lands on the pane.
    const paneYolo = yolo ? { yolo: true as const } : {};
    // Remote: a bare pane carrying the endpoint. The agent's cwd lives on the
    // box the server runs on, so the local worktree/location is moot — the
    // pane's terminal runs the local thin-client attached to the endpoint.
    // (Remote is fresh-session only for now: the dialog forces "new" and
    // hides Start-from, so `session` is never set alongside this.)
    if (remoteEndpoint) {
      currentDeck.addAgentPane(dlg.workspace.id, {
        id: dlg.agentId,
        name: paneName,
        agentType,
        ...paneYolo,
        remoteEndpoint,
      });
      return;
    }
    // Main repo: a bare pane that runs in the workspace cwd.
    if (location.kind === "main") {
      currentDeck.addAgentPane(dlg.workspace.id, {
        id: dlg.agentId,
        name: paneName,
        agentType,
        ...paneYolo,
      });
      return;
    }
    // Existing worktree: attach in place, no git mutation ([F12]-lite).
    if (location.kind === "existing") {
      currentDeck.addAgentPane(dlg.workspace.id, {
        id: dlg.agentId,
        cwd: location.path,
        branch: location.branch || undefined,
        name: paneName,
        agentType,
        ...paneYolo,
      });
      return;
    }
    // New worktree AT the chosen path (created verbatim, no suffix): the pane
    // joins the grid as a provisioning card right away; the background create
    // resolves it — or flips it to the failed card with Retry.
    const pane: Pane = {
      id: dlg.agentId,
      name: paneName,
      agentType,
      ...paneYolo,
      provisioning: {
        repo: ws.cwd,
        path: location.path,
        branch: location.branch || undefined,
        base: location.baseBranch,
        workspace: ws.name,
        index: dlg.index,
      },
    };
    currentDeck.addAgentPane(dlg.workspace.id, pane);
    void runProvisioning(
      [pane],
      provisionInto(currentDeck, dlg.workspace.id),
    );
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
      })),
      total: page.total,
    };
  };

  /** How a session is already held by a pane: running behind a live PTY,
   * dormant (restored, not yet revived), or not at all — the picker dims
   * claimed rows for resume with the honest wording. */
  const sessionClaim = (sessionId: string): "running" | "dormant" | null => {
    for (const w of deckRef.current.workspaces) {
      for (const p of w.panes) {
        if (p.session?.id === sessionId) {
          return p.dormant ? "dormant" : "running";
        }
      }
    }
    return null;
  };

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
