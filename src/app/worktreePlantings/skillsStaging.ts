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
import type { StagingTrimStore } from "../stagingTrims";
import type { WorktreeSkillViews, WorktreeSkillsPlanting } from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export type SkillsStaging = WorktreeSkillsPlanting;

/** What staging reports to, and how it names a workspace there. */
export interface SkillsStagingDeps {
  trims: Pick<StagingTrimStore, "record" | "keep" | "clear">;
  /** The workspace's name as the user sees it now. */
  nameOf(workspaceId: string): string;
}

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

/** A stage's outcome: the views (null when nothing stages), or a failure —
 * which says nothing about the library. */
type Staged = { ok: true; views: WorktreeSkillViews | null } | { ok: false };

export function createSkillsStaging(inOrder: InOrder, deps: SkillsStagingDeps): SkillsStaging {
  const staged = new Map<string, Promise<WorktreeSkillViews | null>>();
  /** Bumped by every invalidation: a stage asked for before one speaks of a
   * library that is gone, and its report must not land over the clear. */
  let generation = 0;

  async function stage(workspace: { id: string }, asked: number): Promise<Staged> {
    const excluded = await unfitSkills();
    if (excluded === null) return { ok: false };
    try {
      const answer = await stageSkills(workspace.id, excluded);
      if (asked === generation) {
        deps.trims.record({ id: workspace.id, name: deps.nameOf(workspace.id) }, answer.trims);
      }
      return { ok: true, views: answer.view };
    } catch (e) {
      log.warn("web:skills", `skills_stage failed; spawning without skills: ${errorMessage(e)}`);
      return { ok: false };
    }
  }

  return {
    skillsFor(workspace) {
      const memoized = staged.get(workspace.instance);
      if (memoized) return memoized;
      const asked = generation;
      const views: Promise<WorktreeSkillViews | null> = inOrder(() => stage(workspace, asked)).then((outcome) => {
        if (outcome.ok) return outcome.views;
        // A failure is no answer about the library: the pane spawns without
        // skills, and the next spawn stages again instead of inheriting it.
        if (staged.get(workspace.instance) === views) staged.delete(workspace.instance);
        return null;
      });
      staged.set(workspace.instance, views);
      return views;
    },

    invalidateSkills() {
      generation += 1;
      staged.clear();
      deps.trims.clear();
    },

    async pruneSkills(liveWsIds) {
      const pruned = await pruneSkills(liveWsIds);
      deps.trims.keep(liveWsIds);
      return pruned;
    },
  };
}
