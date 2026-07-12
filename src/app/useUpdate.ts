import { useSyncExternalStore } from "react";
import {
  getUpdateState,
  subscribeUpdates,
  type UpdateState,
} from "./updateManager";

/**
 * The live in-app update state — a React bridge over the `updateManager`
 * singleton. Read-only by design: actions go through `checkForUpdatesNow`
 * and `restartToUpdate` directly (it isn't React state).
 */
export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribeUpdates, getUpdateState);
}
