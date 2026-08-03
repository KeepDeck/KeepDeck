import type { AgentStatusTracker } from "./agentStatusTracker";
import type { PaneAttribution } from "./paneAttribution";
import type { UsageManager } from "./usageManager";

/**
 * The one owner of "this pane's per-process state starts over" — the sequence
 * every lifecycle point was hand-assembling per store. Three holders now: the
 * two telemetry stores (usage, activity) and the attribution ledger, and they
 * must retire together. The split has already produced a real bug once — the
 * session-generation site cleared usage but kept the dead conversation's
 * activity, so a `/clear` left the pane wearing last conversation's "Rate
 * limited" — and attribution joining them is the same hazard: a pane whose
 * process retired without its ledger being cleared would refuse its OWN next
 * session as a second start.
 *
 * Constructed in the runtime over the holders it retires — each reaches it as
 * a value, never as importable module state.
 */
export interface PaneLifecycle {
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

export function createPaneLifecycle(
  usage: UsageManager,
  tracker: AgentStatusTracker,
  attribution: PaneAttribution,
): PaneLifecycle {
  return {
    retire(paneId) {
      usage.clearPane(paneId);
      tracker.clear(paneId);
      // A NEW process may bind a fresh session — it is the pane's own again.
      attribution.retire(paneId);
    },
    beginSession(paneId, sessionId) {
      usage.beginPaneSession(paneId, sessionId);
      tracker.clear(paneId);
    },
  };
}
