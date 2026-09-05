import {
  autoWorkspaceName,
  findPane,
  findWorkspace,
  findWorkspaceByRef,
  MAX_PANES,
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  type Pane,
  type Workspace,
  locationOf,
} from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { log } from "../../ipc/log";
import type {
  AgentOrchestrator,
  CreatePaneOutcome,
  CreatePaneRequest,
} from ".";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { provisionInto } from "../provisioning";
import { dropPaneSpawnSpec } from "../spawnSpecs";
import type { WorktreeProvisioner } from "../worktrees";

interface CreationDeps {
  deck: DeckStore;
  actions: DeckActions;
  worktrees: WorktreeProvisioner;
}

export interface AgentOrchestratorCreation {
  landPane(request: CreatePaneRequest): CreatePaneOutcome;
  landOrThrow(outcome: CreatePaneOutcome): void;
  createWorkspace: AgentOrchestrator["createWorkspace"];
  retryProvisioning: AgentOrchestrator["retryProvisioning"];
}

export function createAgentOrchestratorCreation({
  deck,
  actions,
  worktrees,
}: CreationDeps): AgentOrchestratorCreation {
  function provisionPanes(wsId: string, panes: Pane[]): void {
    const cards = panes.filter((pane) => locationOf(pane).kind === "provisioning");
    if (cards.length === 0) return;
    void worktrees.provision(cards, provisionInto(actions, wsId));
  }

  function refuse(paneId: string, kind: "gone" | "full"): CreatePaneOutcome {
    dropPaneSpawnSpec(paneId);
    worktrees.clearPostProvision(paneId);
    return { kind };
  }

  function landPane({
    workspace,
    pane,
  }: CreatePaneRequest): CreatePaneOutcome {
    const current = findWorkspaceByRef(deck.getSnapshot().workspaces, workspace);
    if (!current) return refuse(pane.id, "gone");
    if (current.panes.length >= MAX_PANES) return refuse(pane.id, "full");
    actions.addAgentPane(current.id, pane);
    provisionPanes(current.id, [pane]);
    return { kind: "created" };
  }

  function landOrThrow(outcome: CreatePaneOutcome): void {
    switch (outcome.kind) {
      case "created":
        return;
      case "full":
        throw new Error(WORKSPACE_FULL_MESSAGE);
      case "gone":
        throw new Error(WORKSPACE_GONE_MESSAGE);
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled create outcome: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** A workspace is born EMPTY: nothing spawns here, so nothing is provisioned
   * here either. Agents arrive one at a time through `landPane`, each carrying
   * its own location — which is where a worktree create is started now. */
  const createWorkspace: AgentOrchestrator["createWorkspace"] = (config) => {
    const created = actions.createWorkspaceFromSequence((sequence): Workspace => {
      const id = `ws-${sequence}`;
      // The same derivation an empty rename resets to — one home, so the
      // birth name and the reset name cannot drift apart.
      const name = config.name.trim() || autoWorkspaceName(id);
      return {
        id,
        instance: createWorkspaceInstance(),
        name,
        cwd: config.cwd,
        worktreeBaseDir: config.worktreeBaseDir,
        panes: [],
      };
    });
    if (!created.ok) {
      log.error(
        "web:orchestrator",
        `workspace create rejected: ${created.reason}`,
      );
    }
    return created;
  };

  const retryProvisioning: AgentOrchestrator["retryProvisioning"] = (
    wsId,
    paneId,
  ) => {
    const workspaces = deck.getSnapshot().workspaces;
    const workspace = findWorkspace(workspaces, wsId);
    const pane = findPane(workspaces, wsId, paneId);
    if (!workspace || !pane || locationOf(pane).kind !== "provisioning") return;
    actions.setPaneProvisioningError(wsId, paneId, null);
    provisionPanes(wsId, [pane]);
  };

  return { landPane, landOrThrow, createWorkspace, retryProvisioning };
}
