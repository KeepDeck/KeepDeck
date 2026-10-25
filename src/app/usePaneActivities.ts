import { useSyncExternalStore } from "react";
import type { PaneActivity } from "../domain/status";
import type { AgentStatusTracker } from "./agentStatusTracker";

/** The tracker as this hook reads it: its snapshot, and when that changes. */
export type PaneActivitySource = Pick<AgentStatusTracker, "subscribe" | "getSnapshot">;

/**
 * Every pane's live activity, as ONE subscription for whatever surface asks
 * — the strip takes it for its whole column rather than a subscriber per row,
 * which is the shape a list of workspaces holding lists of teams would
 * otherwise grow into.
 *
 * The snapshot is keyed by pane and stable between edges, so a caller's memo
 * recomputes only when an edge actually lands. What the panes MEAN for a
 * workspace's row is decided in `presentation/stripView`: this hook carries
 * the facts and ranks nothing.
 */
export function usePaneActivities(
  statusTracker: PaneActivitySource,
): ReadonlyMap<string, PaneActivity> {
  return useSyncExternalStore(statusTracker.subscribe, statusTracker.getSnapshot)
    .panes;
}
