/**
 * The launch plans of continued sessions. The lifecycle machine continues a
 * recorded session into a pane it mints, and asks for that pane's plan by
 * command — `prepareResume`, or the fork step — before the pane is on the
 * deck.
 *
 * A plan is built from two things, each from its one owner. What the person
 * asked for THIS continuation — its member's draft, YOLO included — rides
 * the command: the machine holds it for the ask it took, and two
 * continuations of one conversation are each built from their own. What is
 * known of the conversation itself — where it was recorded, on what branch,
 * where its transcript is — is noted here by the door before its intent
 * goes, under the session it continues.
 */
import { paneDraftOf, type OwnerRefusal } from "../../domain/lifecycle";
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

/** What is known of a continued conversation, whichever ask continues it. */
export interface ContinuationFacts {
  workspace: WorkspaceRef;
  /** Where a resume runs: the folder the session was recorded in. */
  cwd: string;
  branch?: string;
  /** The transcript a fork copies, when it is known. */
  transcriptPath?: string;
}

/** A plan built — or why it was not, as the owner says it. */
export type Built<T> = { kind: "built"; value: T } | { kind: "refused"; why: OwnerRefusal };

export interface ContinuationPlansDeps {
  plugins: SpawnPluginAccess;
  spawnContext: SpawnContextSource;
  skillsAsk: StagedSkillsAsk;
  mcpAccess: McpAccessAsk;
  armCwd: CwdArmAsk;
}

export interface ContinuationPlans {
  /** Note what is known of `source` in workspace `workspace` — before the
   * intent goes, so its command never arrives first. */
  expect(workspace: string, source: SessionKey, facts: ContinuationFacts): void;
  /** `draft`: the member the command's own ask carried. */
  buildResume(args: { workspace: string; pane: string; source: SessionKey; draft: unknown }): Promise<Built<null>>;
  buildFork(args: { workspace: string; pane: string; source: SessionKey; cwd: string; draft: unknown }): Promise<Built<DeclaredDiscard>>;
}

const keyOf = (workspace: string, source: SessionKey) => `${workspace}\u0000${source.agent}\u0000${source.session}`;

export function createContinuationPlans(deps: ContinuationPlansDeps): ContinuationPlans {
  /** What is known of each conversation continued in this run. Kept, not
   * taken by a build: another continuation of the same conversation, and the
   * machine's retry of the same step, read it too. */
  const known = new Map<string, ContinuationFacts>();

  /** What a build is made from: the facts noted of its source and the YOLO of
   * its own ask — or why it is not built. A build is asked only in the launch
   * whose door noted its source (the machine never asks again one a launch
   * that ended had asked); one with nothing noted has nothing to be built
   * from, and is refused in words rather than guessed at. */
  function inputsOf(workspace: string, source: SessionKey, draft: unknown): { facts: ContinuationFacts; yolo: boolean | undefined } | OwnerRefusal {
    const facts = known.get(keyOf(workspace, source));
    if (!facts) return { kind: "notAsked" };
    const member = paneDraftOf(draft);
    if (!member) return { kind: "unreadable", what: "agent" };
    return { facts, yolo: member.yolo };
  }

  function context() {
    const ctx = deps.spawnContext.get();
    if (!ctx) throw new Error("the agent spawn context is not there yet");
    return ctx;
  }

  return {
    expect(workspace, source, facts) {
      // A note adds to what is known and never takes a field away: a resume
      // knows no transcript, and must not take a fork's from it.
      const key = keyOf(workspace, source);
      const was = known.get(key);
      const branch = facts.branch ?? was?.branch;
      const transcriptPath = facts.transcriptPath ?? was?.transcriptPath;
      known.set(key, {
        workspace: facts.workspace,
        cwd: facts.cwd,
        ...(branch !== undefined && { branch }),
        ...(transcriptPath !== undefined && { transcriptPath }),
      });
    },
    async buildResume({ workspace, pane, source, draft }) {
      const inputs = inputsOf(workspace, source, draft);
      if ("kind" in inputs) return { kind: "refused", why: inputs };
      const { facts, yolo } = inputs;
      const built = await buildResumeSpec(
        deps.plugins,
        source.agent,
        {
          paneId: pane,
          workspace: facts.workspace,
          cwd: facts.cwd,
          branch: facts.branch,
          yolo,
          stagedSkills: deps.skillsAsk(facts.workspace),
          mcpAccess: deps.mcpAccess,
          armCwd: deps.armCwd,
        },
        context(),
        source.session,
        "manual",
      );
      if (!built) throw new Error("the agent could not prepare a resume plan");
      return { kind: "built", value: null };
    },
    async buildFork({ workspace, pane, source, cwd, draft }) {
      const inputs = inputsOf(workspace, source, draft);
      if ("kind" in inputs) return { kind: "refused", why: inputs };
      const { facts, yolo } = inputs;
      const discard = await buildForkSpec(
        deps.plugins,
        source.agent,
        {
          paneId: pane,
          workspace: facts.workspace,
          cwd,
          yolo,
          stagedSkills: deps.skillsAsk(facts.workspace),
          mcpAccess: deps.mcpAccess,
          armCwd: deps.armCwd,
        },
        context(),
        { sessionId: source.session, sourceCwd: facts.cwd, ...(facts.transcriptPath !== undefined && { transcriptPath: facts.transcriptPath }) },
      );
      return { kind: "built", value: discard };
    },
  };
}
