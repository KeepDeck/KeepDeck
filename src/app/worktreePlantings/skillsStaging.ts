/**
 * The skills feature's worktree adapter: it turns the manager's ordering port
 * into staged views. Construction belongs to the runtime composition root;
 * the infrastructure manager only receives the resulting composite planting.
 *
 * It stages and nothing more: what an agent needs planted in a pane's cwd to
 * find the staged skills is that agent's plugin's to declare (`arm.plan`),
 * and the cwd arming engine's to plant.
 */
import { fetchSkills, stageSkills, type ExcludedSkill } from "../../ipc/skills";
import { log } from "../../ipc/log";
import { errorMessage } from "@keepdeck/plugin-api";
import { skillsUnfitForAgents } from "../../domain/skills";
import type { WorktreeSkillViews, WorktreeSkillsPlanting } from "../worktrees";
import type { InOrder } from "../worktrees/queue";

export type SkillsStaging = WorktreeSkillsPlanting;

/** The library rows no agent may be handed, by the codec's judgement — or
 * null when the library could not be read: then nothing stages (a pane
 * spawns fine without skills), rather than staging rows nobody judged. */
async function unfitSkills(): Promise<ExcludedSkill[] | null> {
  try {
    return skillsUnfitForAgents(await fetchSkills()).map(({ scope, wsId, name }) => ({ scope, wsId, name }));
  } catch (e) {
    log.warn("web:skills", `skills_list failed; spawning without skills: ${errorMessage(e)}`);
    return null;
  }
}

export function createSkillsStaging(inOrder: InOrder): SkillsStaging {
  const staged = new Map<string, Promise<WorktreeSkillViews | null>>();

  return {
    skillsFor(workspace) {
      const memoized = staged.get(workspace.instance);
      if (memoized) return memoized;
      const views = inOrder(() =>
        unfitSkills().then((excluded) =>
          excluded === null ? null : stageSkills(workspace.id, excluded),
        ),
      );
      staged.set(workspace.instance, views);
      return views;
    },

    invalidateSkills() {
      staged.clear();
    },
  };
}
