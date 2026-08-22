import { useSyncExternalStore } from "react";
import { skillRefusals } from "./skillRefusals";
import type { SkillArmRefusal } from "../ipc/skills";

/** The cwds skills could not be armed in right now. Empty is the normal
 * answer; a non-empty one is a standing condition the user can end. */
export function useSkillRefusals(): readonly SkillArmRefusal[] {
  return useSyncExternalStore(skillRefusals.subscribe, skillRefusals.get);
}
