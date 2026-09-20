import { tasksDoorBadge } from "../../presentation/tasks";
import { useTasksBoardState } from "./useBoardState";
import type { TasksAccess } from "./useTasksBoard";

/** The number on the Tasks door for the active workspace: what waits on a
 * person there. Zero while the feature is down or the board not loaded. */
export function useTasksAttention(access: TasksAccess, workspaceId: string | null): number {
  return tasksDoorBadge(useTasksBoardState(access, workspaceId));
}
