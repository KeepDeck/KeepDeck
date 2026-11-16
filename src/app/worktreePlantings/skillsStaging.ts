/**
 * The skills feature's worktree adapter: it turns the manager's ordering port
 * into staged views. Construction belongs to the runtime composition root;
 * the infrastructure manager only receives the resulting composite planting.
 *
 * It stages and nothing more: what an agent needs planted in a pane's cwd to
 * find the staged skills is that agent's plugin's to declare (`arm.plan`),
 * and the cwd arming engine's to plant. What a stage could not hand out whole
 * goes to the trims store, beside the views and never inside them.
 */
import { fetchSkills, pruneSkills, stageSkills, type ExcludedSkill } from "../../ipc/skills";
import { log } from "../../ipc/log";
import { errorMessage } from "@keepdeck/plugin-api";
import { skillsUnfitForAgents } from "../../domain/skills";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { StagingTrimStore } from "../stagingTrims";
import type { WorktreeDeckView, WorktreeSkillViews, WorktreeSkillsPlanting } from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export type SkillsStaging = WorktreeSkillsPlanting;

/** The library rows no agent may be handed, by the codec's judgement — or
 * null when the library could not be read: then nothing stages, rather than
 * staging rows nobody judged. */
async function unfitSkills(): Promise<ExcludedSkill[] | null> {
  try {
    return skillsUnfitForAgents(await fetchSkills()).map(({ scope, wsId, name }) => ({ scope, wsId, name }));
  } catch (e) {
    log.warn("web:skills", `skills_list failed; spawning without skills: ${errorMessage(e)}`);
    return null;
  }
}

/**
 * `deck` names the workspace a stage reports under; `trims` is where it
 * reports what it could not hand out whole.
 *
 * Every ask stages afresh: a launch is handed what the library holds at that
 * moment, never an earlier answer. A stage that came out short — the library
 * could not be read whole that once — used to be remembered and re-served to
 * every later launch in the workspace until the user happened to edit a
 * skill; rebuilding per launch makes such a stage cost one launch, not the
 * rest of the session.
 */
export function createSkillsStaging(
  inOrder: InOrder,
  deck: Pick<WorktreeDeckView, "nameOf">,
  trims: Pick<StagingTrimStore, "record" | "keep" | "clear">,
): SkillsStaging {
  /** Bumped by every invalidation: a stage asked for before one speaks of a
   * library that is gone, and its report must not land over the clear. */
  let generation = 0;

  /** Report a stage's trims under its workspace — unless the library moved
   * since it was asked for, or the lifetime it staged is gone (a workspace
   * now holding the same id has not staged yet). */
  function report(workspace: WorkspaceRef, asked: number, said: Parameters<StagingTrimStore["record"]>[1]): void {
    const name = deck.nameOf(workspace);
    if (asked !== generation || name === null) return;
    trims.record({ id: workspace.id, instance: workspace.instance, name }, said);
  }

  /** The views a launch is handed: null when nothing stages, and null when
   * staging failed — then the pane spawns without skills. */
  async function stage(workspace: WorkspaceRef, asked: number): Promise<WorktreeSkillViews | null> {
    const excluded = await unfitSkills();
    if (excluded === null) return null;
    try {
      const answer = await stageSkills(workspace.id, excluded);
      report(workspace, asked, answer.trims);
      return answer.view;
    } catch (e) {
      log.warn("web:skills", `skills_stage failed; spawning without skills: ${errorMessage(e)}`);
      return null;
    }
  }

  return {
    skillsFor(workspace) {
      const asked = generation;
      return inOrder(() => stage(workspace, asked));
    },

    invalidateSkills() {
      generation += 1;
      trims.clear();
    },

    async pruneSkills(live) {
      const pruned = await pruneSkills(live.map((workspace) => workspace.id).sort());
      trims.keep(live.map((workspace) => workspace.instance));
      return pruned;
    },
  };
}
