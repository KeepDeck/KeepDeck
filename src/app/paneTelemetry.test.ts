import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusTracker } from "./agentStatusTracker";
import type { PaneAttribution } from "./paneAttribution";
import type { UsageManager } from "./usageManager";
import { createPaneTelemetry } from "./paneTelemetry";

const usage = {
  clearPane: vi.fn(),
  beginPaneSession: vi.fn(),
} as unknown as UsageManager;

const tracker = { clear: vi.fn() } as unknown as AgentStatusTracker;

const attribution = { retire: vi.fn() } as unknown as PaneAttribution;

describe("paneTelemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retires EVERY holder — the set diverging is the bug this owner exists for", () => {
    createPaneTelemetry(usage, tracker, attribution).retire("pane-1");
    expect(usage.clearPane).toHaveBeenCalledWith("pane-1");
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
    expect(attribution.retire).toHaveBeenCalledWith("pane-1");
  });

  it("a new session generation restarts both telemetry stores", () => {
    createPaneTelemetry(usage, tracker, attribution).beginSession(
      "pane-1",
      "session-2",
    );
    expect(usage.beginPaneSession).toHaveBeenCalledWith("pane-1", "session-2");
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
  });

  it("keeps attribution out of a session generation change", () => {
    // A `/clear` is the pane's OWN agent minting a new id — the pane has
    // still bound once in this process generation, and forgetting that here
    // would re-open the door for the next fresh session that is not its own.
    createPaneTelemetry(usage, tracker, attribution).beginSession(
      "pane-1",
      "session-2",
    );
    expect(attribution.retire).not.toHaveBeenCalled();
  });
});
