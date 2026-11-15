/**
 * Runtime composition for what the worktree owner plants. The owner gets one
 * composite and one disarm home; feature factories receive the owner's single
 * queue and cannot accidentally construct a second ordering guard.
 */
import { cwdArm, cwdDisarm } from "../../ipc/cwdArm";
import type {
  CwdArmReport,
  WorktreeDeckView,
  WorktreePlantingFactories,
  WorktreePlantings,
} from "../worktrees";
import type { InOrder } from "../worktrees/queue";
import { createSweep } from "./sweep";

export { createSkillsStaging } from "./skillsStaging";

const NOTHING_ARMED: CwdArmReport = { armed: [], refused: [] };

export function createWorktreePlantings(
  deck: WorktreeDeckView,
  inOrder: InOrder,
  factories: WorktreePlantingFactories,
): WorktreePlantings {
  const skills = factories.skills(inOrder, deck);

  async function disarm(roots: string[]): Promise<string[] | null> {
    const liveRoots = deck.live().flatMap((ws) => ws.roots);
    const released = await cwdDisarm(roots, liveRoots);
    if (released) factories.onDisarmed(released);
    return released;
  }

  return {
    disarm,
    skillsFor: skills.skillsFor,
    invalidateSkills: skills.invalidateSkills,
    // Asked INSIDE the slot, right before the planting: a plan built before
    // its workspace was archived must not plant there after.
    armCwd: (request) =>
      inOrder(() =>
        deck.live().some((ws) => ws.id === request.workspaceId && ws.archived)
          ? Promise.resolve(NOTHING_ARMED)
          : cwdArm(request),
      ),
    sweep: createSweep(deck, inOrder, disarm, skills.pruneSkills, factories.prunePluginDirs).sweep,
  };
}
