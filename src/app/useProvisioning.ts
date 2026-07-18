import {
  agentSupportsYolo,
  defaultAgentType,
  type AgentInfo,
} from "../domain/agents";
import {
  findPane,
  findWorkspace,
  type SpawnConfig,
  type Workspace,
} from "../domain/deck";
import { mintAgentSeqs, mintWorkspaceSeq } from "./ids";
import { planPanes, provisionInto, runProvisioning } from "./provisioning";
import { getSettings } from "./settingsManager";
import type { Deck } from "./useDeck";

/**
 * Owns workspace provisioning: the create-workspace form submit, the
 * empty-workspace count picker, and the failed-card Retry. All of it is
 * optimistic — panes land in the deck synchronously (as provisioning cards in
 * worktree mode) and the actual worktree creates run in the background, so
 * there is no busy state and nothing to double-submit: the form closes and
 * the count picker unmounts on the same tick that registers the panes.
 */
export function useProvisioning(deck: Deck, agents: AgentInfo[]) {
  /** Add `count` agents to an existing (empty) workspace. */
  const startWorkspace = (workspaceId: string, count: number) => {
    const ws = findWorkspace(deck.workspaces, workspaceId);
    if (!ws) return;
    const startSeq = mintAgentSeqs(count);
    const agentType = defaultAgentType(agents);
    // The count picker has no YOLO toggle, so the global preference decides —
    // gated on the resolved agent's support like every creation surface.
    const yolo =
      (getSettings()?.defaultYolo ?? false) &&
      agentSupportsYolo(agents, agentType);
    const panes = planPanes(ws, startSeq, count, agentType, yolo);
    deck.setPanes(workspaceId, panes);
    void runProvisioning(panes, provisionInto(deck, workspaceId), ws.setup);
  };

  /** Register a whole new workspace from the create form — immediately. */
  const createWorkspace = ({
    name,
    cwd,
    agentType,
    count,
    worktreeBaseDir,
    setup,
    yolo,
  }: SpawnConfig) => {
    const wsSeq = mintWorkspaceSeq(deck.workspaces.map((ws) => ws.id));
    const startSeq = mintAgentSeqs(count);
    const wsName = name.trim() || `workspace-${wsSeq}`;
    const wsSetup = setup?.trim() || undefined;
    const panes = planPanes(
      { cwd, worktreeBaseDir, name: wsName },
      startSeq,
      count,
      agentType,
      yolo ?? false,
    );
    const workspace: Workspace = {
      id: `ws-${wsSeq}`,
      name: wsName,
      cwd,
      worktreeBaseDir,
      // Core field since deck v5: provisioning owns the setup command — it
      // runs whether or not the Run plugin is installed.
      ...(wsSetup && { setup: wsSetup }),
      panes,
    };
    deck.createWorkspace(workspace);
    void runProvisioning(panes, provisionInto(deck, workspace.id), wsSetup);
  };

  /** Re-issue a failed pane's worktree create from its stored intent. */
  const retryPane = (wsId: string, paneId: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const pane = findPane(deck.workspaces, wsId, paneId);
    if (!ws || !pane?.provisioning) return;
    // Back to the creating card first, then re-run the same intent.
    deck.setPaneProvisioningError(wsId, paneId, null);
    void runProvisioning([pane], provisionInto(deck, wsId), ws.setup);
  };

  return { startWorkspace, createWorkspace, retryPane };
}
