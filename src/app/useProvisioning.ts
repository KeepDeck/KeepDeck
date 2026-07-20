import {
  findPane,
  findWorkspace,
  type SpawnConfig,
  type Workspace,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { log } from "../ipc/log";
import { mintAgentSeqs } from "./ids";
import { planPanes, provisionInto, runProvisioning } from "./provisioning";
import type { Deck } from "./useDeck";

/**
 * Owns workspace provisioning: the create-workspace form submit and the
 * failed-card Retry. All of it is optimistic — panes land in the deck
 * synchronously (as provisioning cards in worktree mode) and the actual
 * worktree creates run in the background, so there is no busy state and
 * nothing to double-submit: the form closes on the same tick that registers
 * the panes.
 */
export function useProvisioning(deck: Deck) {
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
    const wsSetup = setup?.trim() || undefined;
    const created = deck.createWorkspaceFromSequence((wsSeq): Workspace => {
      const startSeq = mintAgentSeqs(count);
      const wsName = name.trim() || `workspace-${wsSeq}`;
      const panes = planPanes(
        { cwd, worktreeBaseDir, name: wsName },
        startSeq,
        count,
        agentType,
        yolo ?? false,
      );
      return {
        id: `ws-${wsSeq}`,
        instance: createWorkspaceInstance(),
        name: wsName,
        cwd,
        worktreeBaseDir,
        // Core field since deck v5: provisioning owns the setup command — it
        // runs whether or not the Run plugin is installed.
        ...(wsSetup && { setup: wsSetup }),
        panes,
      };
    });
    if (!created.ok) {
      log.error(
        "web:provisioning",
        `workspace create rejected: ${created.reason}`,
      );
      return created;
    }
    const { workspace } = created;
    void runProvisioning(
      workspace.panes,
      provisionInto(deck, workspace.id),
      wsSetup,
    );
    return created;
  };

  /** Re-issue a failed pane's worktree create from its stored intent. */
  const retryPane = (wsId: string, paneId: string) => {
    const ws = findWorkspace(deck.workspaces, wsId);
    const pane = findPane(deck.workspaces, wsId, paneId);
    if (!ws || !pane?.provisioning) return;
    // Back to the creating card first, then re-run the same intent. The
    // one-time setup command re-runs ONLY for batch panes (they carry
    // `baseDir`): the "+ Agent"/fork flows never ran it in the first place,
    // and a Retry must not have wider effects than the attempt it retries.
    deck.setPaneProvisioningError(wsId, paneId, null);
    const setup = pane.provisioning.baseDir !== undefined ? ws.setup : undefined;
    void runProvisioning([pane], provisionInto(deck, wsId), setup);
  };

  return { createWorkspace, retryPane };
}
