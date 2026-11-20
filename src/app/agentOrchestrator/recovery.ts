/**
 * What the page does about a resume its agent rejected, and about a plan
 * that failed to build — the plan's side of a pane's run, which stays the
 * page's. Neither starts or stops anything the lifecycle owns: the process
 * here has already exited by itself, and the funnel launches the next one by
 * lease.
 */
import { findPane, findWorkspace, paneBranch, paneExecutionCwd, paneResumeSessionId } from "../../domain/deck";
import { decideRejectedResume } from "../../domain/agents";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { log } from "../../ipc/log";
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
import { errorMessage } from "@keepdeck/plugin-api";
import type {
  AgentOrchestrator,
  CwdArmAsk,
  McpAccessAsk,
  OccupiedNote,
  PaneLifecyclePort,
  SessionRegistryPort,
  StagedSkillsAsk,
} from ".";

export interface RecoveryDeps {
  deck: DeckStore;
  actions: DeckActions;
  sessions: SessionRegistryPort;
  plugins: SpawnPluginAccess;
  spawnContext: SpawnContextSource;
  lifecycle: PaneLifecyclePort;
  skillsAsk: StagedSkillsAsk;
  mcpAccess: McpAccessAsk;
  armCwd: CwdArmAsk;
  /** Re-mount a pane's terminal for the next process. */
  bumpEpoch(paneId: string): void;
  publish(): void;
  markOccupied(paneId: string, note: OccupiedNote): void;
  clearNotes(paneId: string): boolean;
  /** A start is owed to this pane: the unopened-workspace economy cannot
   * hold it. */
  owe(paneId: string): void;
  schedule(): void;
}

export interface Recovery {
  recoverRejectedResume: AgentOrchestrator["recoverRejectedResume"];
  retryPlanBuild: AgentOrchestrator["retryPlanBuild"];
  dismissOccupied: AgentOrchestrator["dismissOccupied"];
  /** A recovery is deciding this pane's fate: the funnel leaves it alone. */
  owns(paneId: string): boolean;
}

export function createRecovery(deps: RecoveryDeps): Recovery {
  const recovering = new Set<string>();

  /** Where and what the pane would resume, or null when there is nothing to
   * resume into: the pane is gone, or its folder is still being made. */
  function targetOf(wsId: string, paneId: string) {
    const workspace = findWorkspace(deps.deck.getSnapshot().workspaces, wsId);
    const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
    if (!workspace || !pane) return null;
    const cwd = paneExecutionCwd(workspace, pane);
    if (cwd === null) return null;
    const ref: WorkspaceRef = { id: workspace.id, instance: workspace.instance };
    return { ref, pane, cwd, branch: paneBranch(workspace, pane), sessionId: paneResumeSessionId(pane) };
  }

  /** The exited process is let go of, and the terminal re-mounts for the
   * next one — if the pane is still there. */
  async function letGo(wsId: string, paneId: string): Promise<void> {
    deps.lifecycle.retire(paneId);
    await deps.sessions.close(paneId);
    if (targetOf(wsId, paneId)) deps.bumpEpoch(paneId);
  }

  const recoverRejectedResume: AgentOrchestrator["recoverRejectedResume"] = (wsId, paneId, code) => {
    const spec = peekPaneSpawnSpec(paneId);
    if (!resumeDiedSilently(spec, postbackCount(paneId))) return false;
    if (recovering.has(paneId)) return true;
    if (findPane(deps.deck.getSnapshot().workspaces, wsId, paneId)?.idle) return false;
    const target = targetOf(wsId, paneId);
    if (!target) return false;

    // The pane is taken over the moment the registry question opens; the
    // synchronous answer ("I took it") is what keeps the crash notification
    // off a pane whose fate is still being decided.
    recovering.add(paneId);
    void (async () => {
      try {
        // ASK, don't parse the refusal: the string is not a contract, the
        // registry is the state. `null` (no capability to ask) is its own
        // answer and the rule reads it apart from "absent".
        const answer = spec?.resumeOf ? await askLiveRegistry(deps.plugins, target.pane.agentType, spec.resumeOf) : null;
        const action = decideRejectedResume(answer, spec?.resumeRetry === true);
        if (action.kind === "keep") {
          // The conversation is alive in an outside process: the binding
          // STAYS, the pane stays exited, and its card offers the choice.
          deps.markOccupied(paneId, { registry: action.registry, name: null });
          deps.publish();
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
          if (target.sessionId === null) {
            throw new Error("a quiet retry resumes the pane's session, and it has none bound");
          }
          deps.owe(paneId);
          const context = deps.spawnContext.get();
          if (context) {
            await buildResumeSpec(
              deps.plugins,
              target.pane.agentType,
              {
                paneId,
                workspace: target.ref,
                cwd: target.cwd,
                branch: target.branch,
                yolo: target.pane.yolo,
                stagedSkills: deps.skillsAsk(target.ref),
                mcpAccess: deps.mcpAccess,
                armCwd: deps.armCwd,
              },
              context,
              target.sessionId,
              "restore",
              true,
            );
          }
          await letGo(wsId, paneId);
          log.warn("web:orchestrator", `${paneId}: resume of ${spec?.resumeOf} exited silently, registry says free — one quiet retry`);
          return;
        }
        // The recorded session is truly gone: one automatic fresh start.
        deps.owe(paneId);
        log.warn("web:orchestrator", `${paneId}: resume of ${spec?.resumeOf} exited (${code ?? "?"}) without reporting — respawning fresh`);
        deps.actions.setPaneSession(wsId, paneId, null);
        dropPaneSpawnSpec(paneId);
        await letGo(wsId, paneId);
      } catch (error) {
        log.warn("web:orchestrator", `${paneId}: rejected-resume recovery failed: ${errorMessage(error)}`);
      } finally {
        recovering.delete(paneId);
        deps.schedule();
      }
    })();
    return true;
  };

  return {
    recoverRejectedResume,
    retryPlanBuild(paneId) {
      dropPaneSpawnSpec(paneId);
      clearPanePlanError(paneId);
      deps.bumpEpoch(paneId);
    },
    dismissOccupied(paneId) {
      // The pane stays visible and bound; nothing is erased. Only the offer
      // goes — the ordinary exit card takes over, and a later refused resume
      // can bring the choice back.
      if (deps.clearNotes(paneId)) deps.publish();
    },
    owns: (paneId) => recovering.has(paneId),
  };
}
