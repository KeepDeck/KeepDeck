import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { BoardState } from "../../app/tasks";
import type { TasksAccess } from "./useTasksBoard";

const noop = () => () => {};
const zero = () => 0;

/**
 * One workspace's board as the owner holds it, kept live for a render —
 * the ONE way a surface outside the dialog reads the board (the door's
 * count, the team cards). Null while the feature is down; a render never
 * starts the load, the effect does.
 */
export function useTasksBoardState(access: TasksAccess, workspaceId: string | null): BoardState | null {
  const service = useSyncExternalStore(access.subscribe, access.current, access.current);
  const revision = useSyncExternalStore(
    service ? service.subscribe : noop,
    service ? service.revision : zero,
    service ? service.revision : zero,
  );
  useEffect(() => {
    if (service && workspaceId !== null) void service.ready(workspaceId);
  }, [service, workspaceId]);
  // `revision` is the board's clock: the read changes only when it ticks.
  return useMemo(
    () => (service && workspaceId !== null ? service.peek(workspaceId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, revision],
  );
}
