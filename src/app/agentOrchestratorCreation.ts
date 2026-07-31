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
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { log } from "../ipc/log";
import type {
  AgentOrchestrator,
  CreatePaneOutcome,
  CreatePaneRequest,
  SessionRegistryPort,
} from "./agentOrchestrator";
import type { DeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import { mintAgentSeqs } from "./ids";
import {
  planPanes,
  provisionInto,
  setupStepFor,
} from "./provisioning";
import { dropPaneSpawnSpec } from "./spawnSpecs";
import type { WorktreeProvisioner } from "./worktrees";

interface CreationDeps {
  deck: DeckStore;
  actions: DeckActions;
  sessions: SessionRegistryPort;
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
  sessions,
  worktrees,
}: CreationDeps): AgentOrchestratorCreation {
  function provisionPanes(workspace: Workspace, panes: Pane[]): void {
    const cards = panes.filter((pane) => pane.provisioning);
    const stamped = cards.filter((pane) => pane.provisioning?.runsSetup);
    const plain = cards.filter((pane) => !pane.provisioning?.runsSetup);
    if (stamped.length > 0) {
      const step = workspace.setup
        ? setupStepFor(workspace.setup, sessions.runOnce)
        : undefined;
      void worktrees.provision(
        stamped,
        provisionInto(actions, workspace.id),
        step,
      );
    }
    if (plain.length > 0) {
      void worktrees.provision(plain, provisionInto(actions, workspace.id));
    }
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
    provisionPanes(current, [pane]);
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

  const createWorkspace: AgentOrchestrator["createWorkspace"] = (config) => {
    const setup = config.setup?.trim() || undefined;
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
        ...(setup && { setup }),
        panes: planPanes(
          { cwd: config.cwd, worktreeBaseDir: config.worktreeBaseDir, name },
          mintAgentSeqs(config.count),
          config.count,
          config.agentType,
          config.yolo ?? false,
        ),
      };
    });
    if (!created.ok) {
      log.error(
        "web:orchestrator",
        `workspace create rejected: ${created.reason}`,
      );
      return created;
    }
    provisionPanes(created.workspace, created.workspace.panes);
    return created;
  };

  const retryProvisioning: AgentOrchestrator["retryProvisioning"] = (
    wsId,
    paneId,
  ) => {
    const workspaces = deck.getSnapshot().workspaces;
    const workspace = findWorkspace(workspaces, wsId);
    const pane = findPane(workspaces, wsId, paneId);
    if (!workspace || !pane?.provisioning) return;
    actions.setPaneProvisioningError(wsId, paneId, null);
    provisionPanes(workspace, [pane]);
  };

  return { landPane, landOrThrow, createWorkspace, retryProvisioning };
}
