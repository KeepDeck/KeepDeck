import { useSyncExternalStore } from "react";
import { offBlockedBy, tasksEnableStatus } from "./enableStatus";

/** Why the tasks backend is still open while the setting reads Off — a
 * board it would have closed over unsaved — live; null otherwise. */
export function useTasksOffBlockedBy(): string | null {
  return offBlockedBy(
    useSyncExternalStore(tasksEnableStatus.subscribe, tasksEnableStatus.last, tasksEnableStatus.last),
  );
}
