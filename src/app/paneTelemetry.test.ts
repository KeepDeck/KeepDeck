import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusTracker } from "./agentStatusTracker";
import type { UsageManager } from "./usageManager";
import { createPaneTelemetry } from "./paneTelemetry";

const usage = {
  clearPane: vi.fn(),
  beginPaneSession: vi.fn(),
} as unknown as UsageManager;

const tracker = { clear: vi.fn() } as unknown as AgentStatusTracker;

describe("paneTelemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retires BOTH stores — the pair diverging is the bug this owner exists for", () => {
    createPaneTelemetry(usage, tracker).retire("pane-1");
    expect(usage.clearPane).toHaveBeenCalledWith("pane-1");
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
  });

  it("a new session generation restarts both stores", () => {
    createPaneTelemetry(usage, tracker).beginSession("pane-1", "session-2");
    expect(usage.beginPaneSession).toHaveBeenCalledWith(
      "pane-1",
      "session-2",
    );
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
  });
});
