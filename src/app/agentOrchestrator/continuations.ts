import type { ForkTarget } from "../../domain/agents";
import {
  findWorkspace,
  MAX_PANES,
  paneId,
  placementOfRecorded,
  sessionClaimant,
  WORKSPACE_FULL_MESSAGE,
} from "../../domain/deck";
import { describeError, log } from "../../ipc/log";
import type {
  McpAccessAsk,
  AgentOrchestrator,
  StagedSkillsAsk,
} from ".";
import type { AgentOrchestratorCreation } from "./creation";
import type { DeckStore } from "../deckStore";
import { mintAgentSeq } from "../ids";
import type { SpawnContextSource } from "../spawnContextSource";
import {
  buildForkSpec,
  buildResumeSpec,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
  type SpawnPluginAccess,
} from "../spawnSpecs";
import type { WorktreeProvisioner } from "../worktrees";

interface ContinuationDeps {
  deck: DeckStore;
  spawnContext: SpawnContextSource;
  plugins: SpawnPluginAccess;
  /** Whether a pane's directory is gone — a blocked pane cannot be the live
   * claimant of the session a resume is asking for. */
  isBlocked(paneId: string): boolean;
  creation: AgentOrchestratorCreation;
  skillsAsk: StagedSkillsAsk;
  mcpAccess: McpAccessAsk;
  worktrees: WorktreeProvisioner;
}

export interface AgentOrchestratorContinuations {
  resumeSession: AgentOrchestrator["resumeSession"];
  forkSession: AgentOrchestrator["forkSession"];
}

export function createAgentOrchestratorContinuations({
  deck,
  spawnContext,
  plugins,
  isBlocked,
  creation,
  skillsAsk,
  mcpAccess,
  worktrees,
}: ContinuationDeps): AgentOrchestratorContinuations {
  const resuming = new Set<string>();
  const forking = new Set<string>();

  function claimantOf(sessionId: string) {
    return sessionClaimant(
      deck.getSnapshot().workspaces,
      sessionId,
      isBlocked,
    );
  }

  const resumeSession: AgentOrchestrator["resumeSession"] = async (
    wsId,
    record,
    opts,
  ) => {
    const context = spawnContext.get();
    if (!context) throw new Error("Agent spawn context is unavailable");
    const workspace = findWorkspace(deck.getSnapshot().workspaces, wsId);
    if (!workspace || resuming.has(record.sessionId)) return;
    const claimant = claimantOf(record.sessionId);
    if (claimant) {
      throw new Error(
        claimant.reads === "stopped"
          ? "The session already belongs to a stopped pane — resume that pane instead"
          : "The session is already running in a pane",
      );
    }

    const yolo = opts?.yolo ?? record.yolo;
    resuming.add(record.sessionId);
    try {
      const id = paneId(mintAgentSeq());
      const built = await buildResumeSpec(
        plugins,
        record.agent,
        {
          paneId: id,
          workspace: { id: workspace.id, instance: workspace.instance },
          cwd: record.cwd,
          branch: record.branch,
          yolo,
          stagedSkills: skillsAsk(
            { id: workspace.id, instance: workspace.instance },
            record.cwd,
          ),
          mcpAccess,
        },
        context,
        record.sessionId,
        "manual",
      );
      if (!built || peekPaneSpawnSpec(id)?.resumeOf !== record.sessionId) {
        dropPaneSpawnSpec(id);
        throw new Error("Agent could not prepare a resume plan");
      }
      if (claimantOf(record.sessionId)) {
        dropPaneSpawnSpec(id);
        return;
      }
      const name = opts?.name?.trim();
      const location = placementOfRecorded(record, workspace.cwd);
      const outcome = creation.landPane({
        workspace: { id: workspace.id, instance: workspace.instance },
        pane: {
          id,
          agentType: record.agent,
          ...(location !== undefined && { location }),
          ...(yolo && { yolo: true }),
          ...(name && { name }),
          session: {
            id: record.sessionId,
            boundAt: new Date().toISOString(),
          },
        },
      });
      creation.landOrThrow(outcome);
    } catch (error) {
      log.warn(
        "web:orchestrator",
        `resume of ${record.sessionId} failed: ${describeError(error)}`,
      );
      throw error;
    } finally {
      resuming.delete(record.sessionId);
    }
  };

  const forkSession: AgentOrchestrator["forkSession"] = async (
    wsId,
    record,
    target: ForkTarget,
    opts,
  ) => {
    const context = spawnContext.get();
    if (!context) throw new Error("Agent spawn context is unavailable");
    const workspace = findWorkspace(deck.getSnapshot().workspaces, wsId);
    if (!workspace || forking.has(record.sessionId)) return;
    const yolo = opts?.yolo ?? record.yolo;
    const workspaceRef = { id: workspace.id, instance: workspace.instance };
    forking.add(record.sessionId);
    try {
      const id = paneId(mintAgentSeq());
      const name = opts?.name?.trim();
      const surgery = (cwd: string) =>
        buildForkSpec(
          plugins,
          record.agent,
          {
            paneId: id,
            workspace: workspaceRef,
            cwd,
            yolo,
            stagedSkills: skillsAsk(workspaceRef, cwd),
            mcpAccess,
          },
          context,
          {
            sessionId: record.sessionId,
            sourceCwd: record.cwd,
            ...(record.transcriptPath !== undefined && {
              transcriptPath: record.transcriptPath,
            }),
          },
        );

      if (target.kind === "dir") {
        if (workspace.panes.length >= MAX_PANES) {
          throw new Error(WORKSPACE_FULL_MESSAGE);
        }
        if (!(await surgery(target.cwd))) {
          dropPaneSpawnSpec(id);
          throw new Error("Agent could not prepare a fork plan");
        }
        creation.landOrThrow(
          creation.landPane({
            workspace: workspaceRef,
            pane: {
              id,
              agentType: record.agent,
              ...(() => {
                const location = placementOfRecorded(
                  { cwd: target.cwd, ...(opts?.branch && { branch: opts.branch }) },
                  workspace.cwd,
                );
                return location !== undefined && { location };
              })(),
              ...(yolo && { yolo: true }),
              ...(name && { name }),
            },
          }),
        );
        return;
      }

      worktrees.registerPostProvision(id, async (worktree) => {
        if (!(await surgery(worktree.cwd))) {
          throw new Error("Agent could not prepare a fork plan");
        }
      });
      creation.landOrThrow(
        creation.landPane({
          workspace: workspaceRef,
          pane: {
            id,
            agentType: record.agent,
            ...(yolo && { yolo: true }),
            ...(name && { name }),
            location: {
              kind: "provisioning",
              intent: {
                repo: workspace.cwd,
                path: target.path,
                branch: target.branch,
                ...(target.base !== undefined && { base: target.base }),
                index: workspace.panes.length + 1,
              },
              fork: true,
            },
          },
        }),
      );
    } catch (error) {
      log.warn(
        "web:orchestrator",
        `fork of ${record.sessionId} failed: ${describeError(error)}`,
      );
      throw error;
    } finally {
      forking.delete(record.sessionId);
    }
  };

  return { resumeSession, forkSession };
}
