import { useSyncExternalStore } from "react";
import type { PaneActivity } from "../domain/status";
import { useAppRuntime } from "./runtimeContext";

/**
 * Every pane's live activity, as ONE subscription for whatever surface asks
 * — the rail takes it for its whole list rather than a subscriber per row,
 * which is the shape a list of workspaces holding lists of teams would
 * otherwise grow into.
 *
 * The snapshot is keyed by pane and stable between edges, so a caller's memo
 * recomputes only when an edge actually lands. What the panes MEAN for a
 * workspace's row is decided in `presentation/railView`: this hook carries
 * the facts and ranks nothing.
 */
export function usePaneActivities(): ReadonlyMap<string, PaneActivity> {
  const { statusTracker } = useAppRuntime();
  return useSyncExternalStore(statusTracker.subscribe, statusTracker.getSnapshot)
    .panes;
}
