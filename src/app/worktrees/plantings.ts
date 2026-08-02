/**
 * Everything KeepDeck puts INSIDE a pane's working directory, composed.
 *
 * Two plantings — the workspace's staged shared skills, and the MCP client
 * config a file-fed CLI reads — plus the sweep that retires what no live
 * workspace claims. Each has its own module and its own reason to change; what
 * belongs HERE is the one rule that binds them, and only that.
 *
 * The rule: a teardown undoes BOTH. They are put in the same directories by
 * the same owner, so taking only one back leaves the other pointing into a
 * deleted worktree — and the skills memo caches the RESULT of a call whose
 * SIDE EFFECT was its arming, so a disarm that left the memo alone would serve
 * a cache hit for a directory whose symlink is gone. Stated once, because a
 * teardown and the sweep both need it and spelling it twice let them drift
 * (one filtered its disarm and not its forget).
 */
import { disarmSkills } from "../../ipc/skills";
import { mcpDisarm } from "../../ipc/mcpArming";
import type {
  McpPlanting,
  SkillsInvalidation,
  WorktreeDeckView,
  WorktreeHousekeeping,
  WorktreeProvisioner,
} from "./index";
import { createMcpPlanting } from "./mcpPlanting";
import type { InOrder } from "./queue";
import { unclaimed } from "./roots";
import { createSkillsStaging } from "./skillsStaging";
import { createSweep } from "./sweep";

export type WorktreePlantings = Pick<WorktreeProvisioner, "skillsFor"> &
  McpPlanting &
  WorktreeHousekeeping &
  SkillsInvalidation & {
    /** Take our own hooks out of `roots` and forget the stagings that put
     * them there — the teardown's half of the arming contract. */
    disarm(roots: string[]): Promise<boolean>;
  };

export function createPlantings(
  deck: WorktreeDeckView,
  inOrder: InOrder,
): WorktreePlantings {
  const skills = createSkillsStaging(deck, inOrder);
  const mcp = createMcpPlanting(inOrder);

  /** Take our own hooks out of `roots` — the ones no live workspace still
   * claims — and forget the stagings that put them there. See the module
   * header: the two steps are one step. */
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
    retractMcp: mcp.retractMcp,
    sweep: createSweep(deck, inOrder, disarm).sweep,
  };
}
