import { useSyncExternalStore } from "react";
import { armRefusals, type ArmRefusal } from "./armRefusals";

/** What agents' plugins could not plant in their panes' folders right now.
 * Empty is the normal answer; a non-empty one is a standing condition the
 * user can end. */
export function useArmRefusals(): readonly ArmRefusal[] {
  return useSyncExternalStore(armRefusals.subscribe, armRefusals.get);
}
