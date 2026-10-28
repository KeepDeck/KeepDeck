/**
 * Runtime composition for what the worktree owner plants. The owner gets one
 * composite and one disarm home; feature factories receive the owner's single
 * queue and cannot accidentally construct a second ordering guard.
 */
import { disarmSkills } from "../../ipc/skills";
import { mcpDisarm } from "../../ipc/mcpArming";
import { cwdArm, cwdDisarm } from "../../ipc/cwdArm";
import type {
  WorktreeDeckView,
  WorktreePlantingFactories,
  WorktreePlantings,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";
import { unclaimed } from "../worktrees/roots";
import { createSweep } from "./sweep";

export { createSkillsStaging } from "./skillsStaging";

export function createWorktreePlantings(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  factories: WorktreePlantingFactories,
): WorktreePlantings {
  const skills = factories.skills(deck, inOrder);

  async function disarm(roots: string[]): Promise<boolean> {
    const departed = unclaimed(roots, deck.live());
    const results = await Promise.all([
      disarmSkills(departed),
      mcpDisarm(departed),
      cwdDisarm(departed),
    ]);
    const ok = results.every(Boolean);
    factories.onDisarmed(departed);
    skills.forgetStaged(roots);
    return ok;
  }

  return {
    disarm,
    skillsFor: skills.skillsFor,
    invalidateSkills: skills.invalidateSkills,
    armCwd: (request) => inOrder(() => cwdArm(request)),
    sweep: createSweep(deck, inOrder, disarm, factories.prunePluginDirs).sweep,
  };
}
