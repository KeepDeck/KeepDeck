import { useState } from "react";
import {
  defaultAgentType,
  type AgentInfo,
  type AgentType,
} from "../domain/agents";
import type { AgentDialogResult } from "../domain/agentLocation";
import { paneId, type Pane } from "../domain/panes";
import type { Workspace } from "../domain/workspaces";
import { inspectRepo, suggestWorktree } from "../ipc/worktree";
import { mintAgentSeq } from "./ids";
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
export function useAgentDialog(
  deck: Deck,
  agents: AgentInfo[],
  /** Global default agent preference ([F6]). */
  defaultAgent: AgentType,
) {
  const [dialog, setDialog] = useState<AgentDialogSpec | null>(null);

  const openFor = async (ws: Workspace) => {
    const seq = mintAgentSeq();
    const index = ws.panes.length + 1;
    // Default the type to the last pane's if it's still selectable — the
    // workspace's own momentum beats the global preference ([F6]) — else the
    // preference, else the first installed agent ([F1]).
    const defaultType = defaultAgentType(
      agents,
      ws.panes[ws.panes.length - 1]?.agentType ?? defaultAgent,
    );
    // Offer the worktree location only when the workspace cwd is a git repo.
    const info = await inspectRepo(ws.cwd).catch(() => null);
    const repo = info?.isRepo ? { cwd: ws.cwd, branch: info.branch } : null;
    let suggestedPath = "";
    let suggestedBranch = "";
    if (repo) {
      const s = await suggestWorktree(ws.name, index).catch(() => null);
      if (s) {
        suggestedBranch = s.branch;
        // [F2]: prefill a path ONLY when the workspace has a base folder,
        // otherwise start empty (= main repo) and let the user choose one.
        if (ws.worktreeBaseDir)
          suggestedPath = `${ws.worktreeBaseDir}/${s.folder}`;
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

  const cancel = () => setDialog(null);

  return { dialog, openFor, confirm, cancel };
}
