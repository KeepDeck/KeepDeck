import { useCallback, useSyncExternalStore } from "react";
import {
  paneSessionState,
  subscribeSessions,
  type PaneSessionState,
} from "./ptyManager";

/**
 * Read one pane's process state. A subscription over the session registry —
 * the fact belongs to whoever owns the process, and a view that stored its own
 * copy is how an exit came to outlive the process it described.
 */
export function usePaneSessionState(paneId: string): PaneSessionState {
  const read = useCallback(() => paneSessionState(paneId), [paneId]);
  return useSyncExternalStore(subscribeSessions, read, read);
}
