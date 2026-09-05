/**
 * Runtime composition for what the worktree owner plants. The owner gets one
 * composite and one disarm home; feature factories receive the owner's single
 * queue and cannot accidentally construct a second ordering guard.
 */
import { disarmSkills } from "../../ipc/skills";
import { mcpDisarm } from "../../ipc/mcpArming";
import type {
  WorktreeDeckView,
  WorktreePlantingFactories,
  WorktreePlantings,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";
import { unclaimed } from "../worktrees/roots";
import { createSweep } from "./sweep";

export { createMcpPlanting } from "./mcpPlanting";
export { createSkillsStaging } from "./skillsStaging";

export function createWorktreePlantings(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  factories: WorktreePlantingFactories,
): WorktreePlantings {
  const skills = factories.skills(deck, inOrder);
  const mcp = factories.mcp(inOrder);

  async function disarm(roots: string[]): Promise<boolean> {
    const departed = unclaimed(roots, deck.live());
    const results = await Promise.all([
      disarmSkills(departed),
      mcpDisarm(departed),
    ]);
    const ok = results.every(Boolean);
    skills.forgetStaged(roots);
    return ok;
  }

  return {
    disarm,
    skillsFor: skills.skillsFor,
    invalidateSkills: skills.invalidateSkills,
    plantMcp: mcp.plantMcp,
    sweep: createSweep(deck, inOrder, disarm).sweep,
  };
}
