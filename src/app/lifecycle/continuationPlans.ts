/**
 * The launch plans of continued sessions. The lifecycle machine continues a
 * recorded session into a pane it mints, and asks for that pane's plan by
 * command — `prepareResume`, or the fork step — before the pane is on the
 * deck. What the plan is built from is what the person asked for: the door
 * that sent the intent notes it here under the session it continues, and
 * the command's source names it back.
 */
import type { SessionKey } from "../../ipc/generated/lifecycle/SessionKey";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import type { SpawnContextSource } from "../spawnContextSource";
import {
  buildForkSpec,
  buildResumeSpec,
  type CwdArmAsk,
  type DeclaredDiscard,
  type McpAccessAsk,
  type SpawnPluginAccess,
} from "../spawnSpecs";
import type { StagedSkillsAsk } from "../agentOrchestrator";

/** What a continued session's plan is built from. */
export interface ContinuationFacts {
  workspace: WorkspaceRef;
  /** Where a resume runs: the folder the session was recorded in. */
  cwd: string;
  branch?: string;
  yolo?: boolean;
  /** The transcript a fork copies, when it is known. */
  transcriptPath?: string;
}

export interface ContinuationPlansDeps {
  plugins: SpawnPluginAccess;
  spawnContext: SpawnContextSource;
  skillsAsk: StagedSkillsAsk;
  mcpAccess: McpAccessAsk;
  armCwd: CwdArmAsk;
}

export interface ContinuationPlans {
  /** Note what continuing `source` in workspace `workspace` is built from —
   * before the intent goes, so its command never arrives first. */
  expect(workspace: string, source: SessionKey, facts: ContinuationFacts): void;
  buildResume(args: { workspace: string; pane: string; source: SessionKey }): Promise<void>;
  buildFork(args: { workspace: string; pane: string; source: SessionKey; cwd: string }): Promise<DeclaredDiscard>;
}

const keyOf = (workspace: string, source: SessionKey) => `${workspace}\u0000${source.agent}\u0000${source.session}`;

export function createContinuationPlans(deps: ContinuationPlansDeps): ContinuationPlans {
  const expected = new Map<string, ContinuationFacts>();

  /** The facts the door noted, taken once: a second build of one
   * continuation is the machine's retry of the same step, and it is handed
   * the same facts. */
  function factsOf(workspace: string, source: SessionKey): ContinuationFacts {
    const facts = expected.get(keyOf(workspace, source));
    if (!facts) throw new Error(`nothing was asked to continue ${source.agent} session ${source.session} here`);
    return facts;
  }

  function context() {
    const ctx = deps.spawnContext.get();
    if (!ctx) throw new Error("the agent spawn context is not there yet");
    return ctx;
  }

  return {
    expect(workspace, source, facts) {
      expected.set(keyOf(workspace, source), facts);
    },
    async buildResume({ workspace, pane, source }) {
      const facts = factsOf(workspace, source);
      const built = await buildResumeSpec(
        deps.plugins,
        source.agent,
        {
          paneId: pane,
          workspace: facts.workspace,
          cwd: facts.cwd,
          branch: facts.branch,
          yolo: facts.yolo,
          stagedSkills: deps.skillsAsk(facts.workspace),
          mcpAccess: deps.mcpAccess,
          armCwd: deps.armCwd,
        },
        context(),
        source.session,
        "manual",
      );
      if (!built) throw new Error("the agent could not prepare a resume plan");
      expected.delete(keyOf(workspace, source));
    },
    async buildFork({ workspace, pane, source, cwd }) {
      const facts = factsOf(workspace, source);
      const discard = await buildForkSpec(
        deps.plugins,
        source.agent,
        {
          paneId: pane,
          workspace: facts.workspace,
          cwd,
          yolo: facts.yolo,
          stagedSkills: deps.skillsAsk(facts.workspace),
          mcpAccess: deps.mcpAccess,
          armCwd: deps.armCwd,
        },
        context(),
        { sessionId: source.session, sourceCwd: facts.cwd, ...(facts.transcriptPath !== undefined && { transcriptPath: facts.transcriptPath }) },
      );
      expected.delete(keyOf(workspace, source));
      return discard;
    },
  };
}
