import {
  findPane,
  findWorkspace,
  paneSuspendBlock,
  worktreeTargets,
  type WorktreeTarget,
} from "../../domain/deck";
import { log } from "../../ipc/log";
import type {
  AgentOrchestrator,
  SessionRegistryPort,
  SuspendPolicyPort,
} from ".";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { dropPaneSpawnSpec } from "../spawnSpecs";
import { clearPaneUsage } from "../usageManager";
import type { WorktreeProvisioner } from "../worktrees";

interface ClosingDeps {
  deck: DeckStore;
  actions: DeckActions;
  sessions: SessionRegistryPort;
  suspendPolicy: SuspendPolicyPort;
  worktrees: WorktreeProvisioner;
  /** Whether a pane's directory is gone — a suspend has nothing to come back
   * to. The question, not the map it is answered from. */
  isBlocked(paneId: string): boolean;
}

export interface AgentOrchestratorClosing {
  suspend: AgentOrchestrator["suspend"];
  close: AgentOrchestrator["close"];
}

function dedupeByPath(targets: WorktreeTarget[]): WorktreeTarget[] {
  const byPath = new Map<string, WorktreeTarget>();
  for (const target of targets) {
    if (!byPath.has(target.path)) byPath.set(target.path, target);
  }
  return [...byPath.values()];
}

export function createAgentOrchestratorClosing({
  deck,
  actions,
  sessions,
  suspendPolicy,
  worktrees,
  isBlocked,
}: ClosingDeps): AgentOrchestratorClosing {
  const suspending = new Set<string>();

  const suspend: AgentOrchestrator["suspend"] = async (wsId, paneId) => {
    if (suspending.has(paneId)) return "in-flight";
    const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
    if (!pane) return "gone";
    const refusal = paneSuspendBlock(pane, isBlocked(paneId));
    if (refusal) return refusal;
    suspending.add(paneId);
    try {
      log.info("web:orchestrator", `${paneId}: suspending`);
      actions.suspendPane(wsId, paneId, suspendPolicy.moveToTray());
      dropPaneSpawnSpec(paneId);
      clearPaneUsage(paneId);
      await sessions.close(paneId);
      return "suspended";
    } finally {
      suspending.delete(paneId);
    }
  };

  const close: AgentOrchestrator["close"] = async (request) => {
    const workspace = findWorkspace(
      deck.getSnapshot().workspaces,
      request.wsId,
    );
    const paneIds =
      request.kind === "agent"
        ? [request.paneId]
        : (workspace?.panes.map((pane) => pane.id) ?? []);
    for (const paneId of paneIds) {
      dropPaneSpawnSpec(paneId);
      clearPaneUsage(paneId);
      worktrees.clearPostProvision(paneId);
    }
    const created = (
      await Promise.all(paneIds.map((paneId) => worktrees.awaitCreated(paneId)))
    ).filter((worktree) => worktree !== null);
    const doomed = request.deleteWorktrees
      ? dedupeByPath([
          ...request.worktrees,
          ...(workspace
            ? worktreeTargets(
                workspace,
                request.kind === "agent" ? request.paneId : undefined,
              )
            : []),
          ...created,
        ])
      : [];

    if (request.kind === "agent") {
      actions.closeAgent(request.wsId, request.paneId);
    } else {
      actions.closeWorkspace(request.wsId);
    }
    await Promise.allSettled(paneIds.map((paneId) => sessions.close(paneId)));
    return doomed.length === 0 ? [] : worktrees.remove(doomed);
  };

  return { suspend, close };
}
