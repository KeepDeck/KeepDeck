import {
  findPane,
  findWorkspace,
  findWorkspaceByRef,
  paneAgentType,
  paneResumeSessionId,
} from "../../domain/deck";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { decideRejectedResume } from "../../domain/agents";
import { describeError, log } from "../../ipc/log";
import type {
  McpAccessAsk,
  AgentOrchestrator,
  OccupiedNote,
  RestartOutcome,
  SessionRegistryPort,
  StagedSkillsAsk,
  PaneLifecyclePort,
} from ".";
import type { DeckActions } from "../deckActions";
import type { DeckStore } from "../deckStore";
import { askLiveRegistry } from "../liveSessions";
import { postbackCount } from "../postbacks";
import type { SpawnContextSource } from "../spawnContextSource";
import {
  buildResumeSpec,
  clearPanePlanError,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
  resumeDiedSilently,
  type SpawnPluginAccess,
} from "../spawnSpecs";

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
  /** Re-mount a pane's terminal — the view store owns the generation and
   * publishes it; a restart only says which pane. */
  bumpEpoch(paneId: string): void;
  /** Publish the run view — the occupied card a recovery lands on is part
   * of it, and a pane's fate changing must reach every listener. */
  publish(): void;
  /** The occupied note a live refusal leaves on the pane's card. */
  markOccupied(paneId: string, note: OccupiedNote): void;
  /** The occupied note, when one is standing. */
  occupiedNote(paneId: string): OccupiedNote | null;
  /** Forget a pane's notes (blocked / wake-failed / occupied). */
  clearNotes(paneId: string): boolean;
  startOwed: Set<string>;
  skillsAsk: StagedSkillsAsk;
  mcpAccess: McpAccessAsk;
  schedule(): void;
  lifecycle: PaneLifecyclePort;
  /** The continuation flows (resume/fork into a new pane) — the occupied
   * card's fork button rides the SAME path the dialog's fork does. */
  forks: {
    forkSession: AgentOrchestrator["forkSession"];
  };
}

export interface AgentOrchestratorRestart {
  restart: AgentOrchestrator["restart"];
  recoverRejectedResume: AgentOrchestrator["recoverRejectedResume"];
  retryPlanBuild: AgentOrchestrator["retryPlanBuild"];
  forkOccupiedSession: AgentOrchestrator["forkOccupiedSession"];
  dismissOccupied: AgentOrchestrator["dismissOccupied"];
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
  bumpEpoch,
  publish,
  markOccupied,
  occupiedNote,
  clearNotes,
  startOwed,
  skillsAsk,
  mcpAccess,
  schedule,
  lifecycle,
  forks,
}: RestartDeps): AgentOrchestratorRestart {
  const restarting = new Set<string>();

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
    lifecycle.retire(target.paneId);
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
        mcpAccess,
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

    lifecycle.retire(target.paneId);
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

    // The pane is taken over the moment the registry question opens; the
    // synchronous answer ("I took it") is what keeps the crash
    // notification off a pane whose fate is still being decided.
    restarting.add(paneId);
    void (async () => {
      try {
        // ASK, don't parse the refusal: the string is not a contract, the
        // registry is the state. `null` (no capability to ask) is its own
        // answer and the rule reads it apart from "absent".
        const answer = spec?.resumeOf
          ? await askLiveRegistry(plugins, target.agentType, spec.resumeOf)
          : null;
        const action = decideRejectedResume(
          answer,
          spec?.resumeRetry === true,
        );
        if (action.kind === "keep") {
          // The conversation is alive in an outside process: the binding
          // STAYS, the pane stays exited, and its card offers the choice.
          // The occupied note survives the spec being dropped later — it
          // lives in the view, not in the plan.
          markOccupied(paneId, {
            registry: action.registry,
            name: null,
          });
          publish();
          log.warn(
            "web:orchestrator",
            `${paneId}: resume of ${spec?.resumeOf} refused — the session is ${action.registry === "live" ? "live outside" : "possibly live (registry unanswered)"}; binding kept, choice offered`,
          );
          return;
        }
        if (action.kind === "retry-once") {
          // The registry says the session is NOT held — but a refusal a
          // moment ago proved it exists. An agent that finished in between
          // vanished from the registry while the conversation became fully
          // resumable: one quiet retry recovers exactly that race.
          startOwed.add(paneId);
          const context = spawnContext.get();
          if (context) {
            await buildResumeSpec(
              plugins,
              target.agentType,
              {
                paneId,
                workspace: target.workspace,
                cwd: target.cwd,
                branch: target.branch,
                yolo: target.yolo,
                stagedSkills: skillsAsk(target.workspace),
                mcpAccess,
              },
              context,
              target.sessionId!,
              "restore",
              true,
            );
          }
          lifecycle.retire(paneId);
          await sessions.close(paneId);
          if (targetOf(target.workspace, paneId)) bumpEpoch(paneId);
          log.warn(
            "web:orchestrator",
            `${paneId}: resume of ${spec?.resumeOf} exited silently, registry says free — one quiet retry`,
          );
          return;
        }
        // legacy-fresh: the recorded session is truly gone. The old
        // behavior, whole — including the one automatic fresh spawn.
        startOwed.add(paneId);
        log.warn(
          "web:orchestrator",
          `${paneId}: resume of ${spec?.resumeOf} exited (${code ?? "?"}) without reporting — respawning fresh`,
        );
        actions.setPaneSession(target.workspace.id, paneId, null);
        dropPaneSpawnSpec(paneId);
        lifecycle.retire(paneId);
        await sessions.close(paneId);
        if (targetOf(target.workspace, paneId)) bumpEpoch(paneId);
      } catch (error) {
        log.warn(
          "web:orchestrator",
          `${paneId}: rejected-resume recovery failed: ${describeError(error)}`,
        );
      } finally {
        restarting.delete(paneId);
        schedule();
      }
    })();
    return true;
  };

  const forkOccupiedSession: AgentOrchestrator["forkOccupiedSession"] =
    async (wsId, paneId) => {
      const target = targetOf(wsId, paneId);
      if (!occupiedNote(paneId) || !target?.sessionId) return;
      // Same directory by definition — the card never chooses one. The
      // record carries no transcript path: the plugin's fork recipe owns
      // its store layout and locates the source itself.
      await forks.forkSession(
        wsId,
        {
          agent: target.agentType,
          sessionId: target.sessionId,
          cwd: target.cwd,
          ...(target.branch !== undefined && { branch: target.branch }),
          ...(target.yolo && { yolo: true }),
        },
        { kind: "dir", cwd: target.cwd },
      );
    };

  const dismissOccupied: AgentOrchestrator["dismissOccupied"] = (paneId) => {
    // The pane stays visible and bound; nothing is erased. Only the
    // offer goes — the ordinary exit card takes over, and a later
    // refused resume can bring the choice back.
    if (clearNotes(paneId)) publish();
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
    forkOccupiedSession,
    dismissOccupied,
    owns: (paneId) => restarting.has(paneId),
  };
}
