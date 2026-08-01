import type { AgentStatusTracker } from "./agentStatusTracker";
import { beginPaneUsageSession, clearPaneUsage } from "./usageManager";

/**
 * The one owner of "this pane's telemetry starts over" — the sequence every
 * lifecycle point was hand-assembling per store. Two stores hold per-pane
 * telemetry (usage, activity) and the pair must retire together: the split
 * has already produced a real bug once — the session-generation site cleared
 * usage but kept the dead conversation's activity, so a `/clear` left the
 * pane wearing last conversation's "Rate limited".
 *
 * Constructed in the runtime over the tracker it retires; the usage store
 * is still a module (its factory migration is its own change).
 */
export interface PaneTelemetry {
  /** The pane's process is retiring (restart, suspend, close, exit):
   * whatever its telemetry said is no longer a fact about the pane. */
  retire(paneId: string): void;
  /** The pane's agent minted a NEW session generation (`/clear`, a fresh
   * rollout): last generation's telemetry must not survive into this one.
   * Call on an actual generation change — the usage half keeps a
   * same-session report that merely overtook its binding, and the activity
   * half starts blank either way. */
  beginSession(paneId: string, sessionId: string): void;
}

export function createPaneTelemetry(
  tracker: AgentStatusTracker,
): PaneTelemetry {
  return {
    retire(paneId) {
      clearPaneUsage(paneId);
      tracker.clear(paneId);
    },
    beginSession(paneId, sessionId) {
      beginPaneUsageSession(paneId, sessionId);
      tracker.clear(paneId);
    },
  };
}
