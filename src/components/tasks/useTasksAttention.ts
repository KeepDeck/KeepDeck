import { useEffect, useMemo, useSyncExternalStore } from "react";
import { tasksDoorBadge } from "../../presentation/tasks";
import type { TasksAccess } from "./useTasksBoard";

const noop = () => () => {};
const zero = () => 0;

/** The number on the Tasks door for the active workspace: what waits on a
 * person there. Zero while the feature is down or the board not loaded. */
export function useTasksAttention(access: TasksAccess, workspaceId: string | null): number {
  const service = useSyncExternalStore(access.subscribe, access.current, access.current);
  const revision = useSyncExternalStore(
    service ? service.subscribe : noop,
    service ? service.revision : zero,
    service ? service.revision : zero,
  );
  useEffect(() => {
    if (service && workspaceId !== null) void service.ready(workspaceId);
  }, [service, workspaceId]);
  return useMemo(
    () => tasksDoorBadge(service && workspaceId !== null ? service.peek(workspaceId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, revision],
  );
}
