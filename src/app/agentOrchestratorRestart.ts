import {
  findPane,
  findWorkspace,
  findWorkspaceByRef,
  paneAgentType,
  paneResumeSessionId,
} from "../domain/deck";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { describeError, log } from "../ipc/log";
import type {
  AgentOrchestrator,
  RestartOutcome,
  SessionRegistryPort,
  StagedSkillsAsk,
} from "./agentOrchestrator";
import type { DeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import { postbackCount } from "./postbacks";
import type { SpawnContextSource } from "./spawnContextSource";
import {
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
  resumeDiedSilently,
  type SpawnPluginAccess,
} from "./spawnSpecs";
import { clearPaneUsage } from "./usageManager";

interface RestartTarget {
  workspace: WorkspaceRef;
  paneId: string;
  agentType: string;
  cwd: string;
  branch: string | undefined;
  yolo: boolean | undefined;
  sessionId: string | null;
}

interface RestartDeps {
  deck: DeckStore;
  actions: DeckActions;
  sessions: SessionRegistryPort;
  plugins: SpawnPluginAccess;
  spawnContext: SpawnContextSource;
  epochs: Map<string, number>;
  startOwed: Set<string>;
  skillsAsk: StagedSkillsAsk;
  publish(): void;
  schedule(): void;
}

export interface AgentOrchestratorRestart {
  restart: AgentOrchestrator["restart"];
  recoverRejectedResume: AgentOrchestrator["recoverRejectedResume"];
  retryPlanBuild: AgentOrchestrator["retryPlanBuild"];
  owns(paneId: string): boolean;
}

function sameResumeTarget(
  current: RestartTarget,
  expected: RestartTarget,
): boolean {
  return (
    current.agentType === expected.agentType &&
    current.cwd === expected.cwd &&
    current.branch === expected.branch &&
    current.sessionId === expected.sessionId
  );
}

export function createAgentOrchestratorRestart({
  deck,
  actions,
  sessions,
  plugins,
  spawnContext,
  epochs,
  startOwed,
  skillsAsk,
  publish,
  schedule,
}: RestartDeps): AgentOrchestratorRestart {
  const restarting = new Set<string>();

  function bumpEpoch(paneId: string): void {
    epochs.set(paneId, (epochs.get(paneId) ?? 0) + 1);
    publish();
  }

  function targetOf(
    workspaceRef: string | WorkspaceRef,
    paneId: string,
  ): RestartTarget | null {
    const workspaces = deck.getSnapshot().workspaces;
    const workspace =
      typeof workspaceRef === "string"
        ? findWorkspace(workspaces, workspaceRef)
        : findWorkspaceByRef(workspaces, workspaceRef);
    const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
    if (!workspace || !pane) return null;
    return {
      workspace: { id: workspace.id, instance: workspace.instance },
      paneId,
      agentType: paneAgentType(pane),
      cwd: pane.cwd ?? workspace.cwd,
      branch: pane.branch,
      yolo: pane.yolo,
      sessionId: paneResumeSessionId(pane),
    };
  }

  function stoppedNow(target: RestartTarget): boolean {
    return !!findPane(
      deck.getSnapshot().workspaces,
      target.workspace.id,
      target.paneId,
    )?.idle;
  }

  async function restartFresh(
    target: RestartTarget,
  ): Promise<RestartOutcome> {
    dropPaneSpawnSpec(target.paneId);
    clearPaneUsage(target.paneId);
    await sessions.close(target.paneId);
    if (!targetOf(target.workspace, target.paneId)) return "gone";
    if (stoppedNow(target)) return "stopped";
    actions.setPaneSession(target.workspace.id, target.paneId, null);
    bumpEpoch(target.paneId);
    return "restarted";
  }

  async function restartResume(
    target: RestartTarget,
  ): Promise<RestartOutcome> {
    const context = spawnContext.get();
    if (!context) throw new Error("Agent spawn context is unavailable");
    if (!target.sessionId) return restartFresh(target);

    dropPaneSpawnSpec(target.paneId);
    const planBuilt = await buildResumeSpec(
      plugins,
      target.agentType,
      {
        paneId: target.paneId,
        workspace: target.workspace,
        cwd: target.cwd,
        branch: target.branch,
        yolo: target.yolo,
        stagedSkills: skillsAsk(target.workspace),
      },
      context,
      target.sessionId,
      "manual",
    );

    const current = targetOf(target.workspace, target.paneId);
    if (!current) {
      dropPaneSpawnSpec(target.paneId);
      return "gone";
    }
    if (stoppedNow(target)) return "stopped";
    if (!sameResumeTarget(current, target)) {
      dropPaneSpawnSpec(target.paneId);
      throw new Error("Agent changed while its restart was being prepared");
    }
    const spec = peekPaneSpawnSpec(target.paneId);
    if (
      !planBuilt ||
      spec?.resumeOrigin !== "manual" ||
      spec.resumeOf !== target.sessionId
    ) {
      dropPaneSpawnSpec(target.paneId);
      throw new Error("Agent could not prepare a resume plan");
    }

    clearPaneUsage(target.paneId);
    await sessions.close(target.paneId);
    if (!targetOf(target.workspace, target.paneId)) {
      dropPaneSpawnSpec(target.paneId);
      return "gone";
    }
    if (stoppedNow(target)) {
      dropPaneSpawnSpec(target.paneId);
      return "stopped";
    }
    bumpEpoch(target.paneId);
    return "restarted";
  }

  const restart: AgentOrchestrator["restart"] = async (
    wsId,
    paneId,
    mode,
  ) => {
    if (restarting.has(paneId)) return "in-flight";
    const target = targetOf(wsId, paneId);
    if (!target) return "gone";
    restarting.add(paneId);
    startOwed.add(paneId);
    try {
      const effective =
        mode === "resume" && target.sessionId ? "resume" : "fresh";
      log.info(
        "web:orchestrator",
        `${paneId}: manual restart (${effective})`,
      );
      return effective === "resume"
        ? await restartResume(target)
        : await restartFresh(target);
    } catch (error) {
      log.warn(
        "web:orchestrator",
        `${paneId}: restart failed: ${describeError(error)}`,
      );
      throw error;
    } finally {
      restarting.delete(paneId);
      schedule();
    }
  };

  const recoverRejectedResume: AgentOrchestrator["recoverRejectedResume"] = (
    wsId,
    paneId,
    code,
  ) => {
    const spec = peekPaneSpawnSpec(paneId);
    if (!resumeDiedSilently(spec, postbackCount(paneId))) return false;
    if (restarting.has(paneId)) return true;
    if (findPane(deck.getSnapshot().workspaces, wsId, paneId)?.idle) {
      return false;
    }
    const target = targetOf(wsId, paneId);
    if (!target) return false;

    restarting.add(paneId);
    startOwed.add(paneId);
    log.warn(
      "web:orchestrator",
      `${paneId}: resume of ${spec?.resumeOf} exited (${code ?? "?"}) without reporting — respawning fresh`,
    );
    actions.setPaneSession(target.workspace.id, paneId, null);
    dropPaneSpawnSpec(paneId);
    clearPaneUsage(paneId);
    void sessions
      .close(paneId)
      .then(() => {
        if (targetOf(target.workspace, paneId)) bumpEpoch(paneId);
      })
      .finally(() => {
        restarting.delete(paneId);
        schedule();
      });
    return true;
  };

  const retryPlanBuild: AgentOrchestrator["retryPlanBuild"] = (paneId) => {
    dropPaneSpawnSpec(paneId);
    clearPanePlanError(paneId);
    bumpEpoch(paneId);
  };

  return {
    restart,
    recoverRejectedResume,
    retryPlanBuild,
    owns: (paneId) => restarting.has(paneId),
  };
}
