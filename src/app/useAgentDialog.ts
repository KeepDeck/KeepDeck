import { useState } from "react";
import {
  defaultAgentType,
  type AgentDialogResult,
  type AgentInfo,
  type AgentType,
} from "../domain/agents";
import {
  baseName,
  firstFreeWorktree,
  paneId,
  parentDir,
  type Pane,
  type Workspace,
} from "../domain/deck";
import { inspectRepo, probeWorktree, suggestWorktree } from "../ipc/worktree";
import { mintAgentSeq } from "./ids";
import { getSettings } from "./settingsManager";
import { provisionInto, runProvisioning } from "./provisioning";
import type { Deck } from "./useDeck";

/** Everything the "+ Agent" dialog needs to render, captured at open time. */
export interface AgentDialogSpec {
  wsId: string;
  agentId: string;
  index: number;
  defaultAgentType: AgentType;
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
export function useAgentDialog(deck: Deck, agents: AgentInfo[]) {
  const [dialog, setDialog] = useState<AgentDialogSpec | null>(null);

  /** Per-index name suggestion for `ws`, IPC failures flattened to null. */
  const suggestFor = (ws: Workspace) => (index: number) =>
    suggestWorktree(ws.name, index).catch(() => null);

  /** Disk probe for suggestion filtering, IPC failures flattened to null
   * (= don't filter — the dialog's live hint still guards the create). */
  const probeFor = (path: string) => probeWorktree(path).catch(() => null);

  const openFor = async (ws: Workspace) => {
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
          deck.workspaces,
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
    setDialog({
      wsId: ws.id,
      agentId: paneId(seq),
      index,
      defaultAgentType: defaultType,
      repo,
      suggestedPath,
      suggestedBranch,
    });
  };

  const confirm = ({ agentType, name, location }: AgentDialogResult) => {
    const dlg = dialog;
    if (!dlg) return;
    setDialog(null);
    const ws = deck.workspaces.find((w) => w.id === dlg.wsId);
    if (!ws) return;
    const paneName = name.trim() || undefined;
    // Main repo: a bare pane that runs in the workspace cwd.
    if (location.kind === "main") {
      deck.addAgentPane(dlg.wsId, {
        id: dlg.agentId,
        name: paneName,
        agentType,
      });
      return;
    }
    // Existing worktree: attach in place, no git mutation ([F12]-lite).
    if (location.kind === "existing") {
      deck.addAgentPane(dlg.wsId, {
        id: dlg.agentId,
        cwd: location.path,
        branch: location.branch || undefined,
        name: paneName,
        agentType,
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
      provisioning: {
        repo: ws.cwd,
        path: location.path,
        branch: location.branch || undefined,
        workspace: ws.name,
        index: dlg.index,
      },
    };
    deck.addAgentPane(dlg.wsId, pane);
    void runProvisioning([pane], provisionInto(deck, dlg.wsId));
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
    const ws = deck.workspaces.find((w) => w.id === dlg.wsId);
    if (!ws) return null;
    const base = ws.worktreeBaseDir ?? parentDir(currentPath);
    if (!base) return null;
    return firstFreeWorktree(
      deck.workspaces,
      base,
      suggestFor(ws),
      dlg.index,
      probeFor,
    );
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
    const ws = deck.workspaces.find((w) => w.id === dlg.wsId);
    if (!ws) return null;
    const folder = baseName(path);
    if (!folder) return null;
    const tail = /-(\d+)$/.exec(folder);
    if (tail) {
      const s = await suggestFor(ws)(Number(tail[1]));
      if (s?.folder === folder) return s.branch;
    }
    return folder;
  };

  const cancel = () => setDialog(null);

  return { dialog, openFor, confirm, cancel, nextFree, branchFor };
}
