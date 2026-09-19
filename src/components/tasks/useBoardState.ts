import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { BoardState, TasksService } from "../../app/tasks";
import type { TasksAccess } from "./useTasksBoard";

const noop = () => () => {};
const zero = () => 0;

/**
 * The board's feed — the ONE way any surface reads it: the owner as the
 * runtime hands it out (null while the feature is down), its revision as
 * the clock, and one workspace's board kept live for a render. The load
 * is started by the effect, never by the render.
 */
export function useTasksBoardFeed(
  access: TasksAccess,
  workspaceId: string | null,
): { service: TasksService | null; revision: number; state: BoardState | null } {
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
  const state = useMemo(
    () => (service && workspaceId !== null ? service.peek(workspaceId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, workspaceId, revision],
  );
  return { service, revision, state };
}

/** One workspace's board for a surface that only reads it — the door's
 * count, the team cards. */
export function useTasksBoardState(access: TasksAccess, workspaceId: string | null): BoardState | null {
  return useTasksBoardFeed(access, workspaceId).state;
}
