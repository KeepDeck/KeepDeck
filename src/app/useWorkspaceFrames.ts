import { useMemo, useSyncExternalStore } from "react";
import type { Workspace } from "../domain/deck";
import { workspaceFrame, type PaneFrame } from "../domain/status";
import { useAppRuntime } from "./runtimeContext";

/**
 * Each workspace's status frame for the rail dots — ONE subscription for
 * the whole rail, the fold in the domain ([`workspaceFrame`]). The tracker
 * snapshot is stable between changes, so the memo recomputes only when an
 * edge lands, the deck changes shape, or the active workspace moves.
 */
export function useWorkspaceFrames(
  workspaces: Workspace[],
  activeId: string,
): ReadonlyMap<string, PaneFrame> {
  const { statusTracker } = useAppRuntime();
  const snapshot = useSyncExternalStore(
    statusTracker.subscribe,
    statusTracker.getSnapshot,
  );
  return useMemo(() => {
    const frames = new Map<string, PaneFrame>();
    for (const workspace of workspaces) {
      frames.set(
        workspace.id,
        workspaceFrame(
          workspace.panes.map((pane) => snapshot.panes.get(pane.id)),
          workspace.id === activeId,
        ),
      );
    }
    return frames;
  }, [workspaces, activeId, snapshot]);
}
