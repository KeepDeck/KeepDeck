import { useSyncExternalStore } from "react";
import { stagingTrims, type WorkspaceTrim } from "./stagingTrims";

/** What staging could not hand agents whole right now. Empty is the normal
 * answer; a non-empty one is a standing condition the user can end. */
export function useStagingTrims(): readonly WorkspaceTrim[] {
  return useSyncExternalStore(stagingTrims.subscribe, stagingTrims.get);
}
