import { useRef, useState } from "react";
import { defaultAgentType, type AgentInfo } from "../domain/agents";
import type { SpawnConfig, Workspace } from "../domain/workspaces";
import { mintAgentSeqs, mintWorkspaceSeq } from "./ids";
import { provisionPanes } from "./provisioning";
import type { Deck } from "./useDeck";

/**
 * Owns workspace provisioning: the create-workspace form submit and the
 * empty-workspace count picker. One reentrancy guard covers both — a ref, not
 * state, so a second submit during the await can't double-provision; `busy` is
 * the render-time mirror that disables the UI.
 */
export function useProvisioning(
  deck: Deck,
  agents: AgentInfo[],
  onError: (message: string) => void,
) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);

  /** Run one provisioning job under the guard; resolves false when skipped. */
  const run = async (job: () => Promise<void>): Promise<boolean> => {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    try {
      await job();
      return true;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  /** Add `count` agents to an existing (empty) workspace. */
  const startWorkspace = (workspaceId: string, count: number) =>
    run(async () => {
      const ws = deck.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const startSeq = mintAgentSeqs(count);
      const panes = await provisionPanes(
        ws,
        startSeq,
        count,
        defaultAgentType(agents),
        onError,
      );
      deck.setPanes(workspaceId, panes);
    });

  /** Provision and register a whole new workspace from the create form. */
  const createWorkspace = ({
    name,
    cwd,
    agentType,
    count,
    worktreeBaseDir,
  }: SpawnConfig) =>
    run(async () => {
      const wsSeq = mintWorkspaceSeq();
      const startSeq = mintAgentSeqs(count);
      const wsName = name.trim() || `workspace-${wsSeq}`;
      const panes = await provisionPanes(
        { cwd, worktreeBaseDir, name: wsName },
        startSeq,
        count,
        agentType,
        onError,
      );
      const workspace: Workspace = {
        id: `ws-${wsSeq}`,
        name: wsName,
        cwd,
        worktreeBaseDir,
        panes,
      };
      deck.createWorkspace(workspace);
    });

  return { busy, startWorkspace, createWorkspace };
}
