/**
 * Runtime composition for what a pane's directory is handed at launch: the
 * skills feature's staging and the cwd arming engine, behind the owner's
 * ports. Whether a folder may be written into at all is the lifecycle's to
 * answer, natively.
 */
import { cwdArm } from "../../ipc/cwdArm";
import type { WorktreePlantings, WorktreeSkillsPlanting } from "../worktrees";

export { createSkillsStaging } from "./skillsStaging";

export function createWorktreePlantings(staging: WorktreeSkillsPlanting): WorktreePlantings {
  return {
    skillsFor: staging.skillsFor,
    invalidateSkills: staging.invalidateSkills,
    armCwd: cwdArm,
  };
}
