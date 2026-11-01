import { useSyncExternalStore } from "react";
import type { AgentPermissionMode } from "@keepdeck/plugin-api";
import { useRuntimePart } from "./runtimeContext";

/**
 * The mode ONE pane's agent last said it runs in — or null until it says.
 * A narrow selector, like [`usePaneActivity`]: the mode is a string, so the
 * caller re-renders only when THIS pane's mode changes.
 */
export function usePaneMode(paneId: string): AgentPermissionMode | null {
  const statusTracker = useRuntimePart("statusTracker");
  return useSyncExternalStore(statusTracker.subscribe, () =>
    statusTracker.getSnapshot().modes.get(paneId) ?? null,
  );
}
