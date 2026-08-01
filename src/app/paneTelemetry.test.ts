import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPaneTelemetrySession,
  retirePaneTelemetry,
} from "./paneTelemetry";

const usage = vi.hoisted(() => ({
  clearPaneUsage: vi.fn(),
  beginPaneUsageSession: vi.fn(),
}));
vi.mock("./usageManager", () => usage);
const tracker = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("./agentStatusTracker", () => ({ agentStatusTracker: tracker }));

describe("paneTelemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retires BOTH stores — the pair diverging is the bug this owner exists for", () => {
    retirePaneTelemetry("pane-1");
    expect(usage.clearPaneUsage).toHaveBeenCalledWith("pane-1");
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
  });

  it("a new session generation restarts both stores", () => {
    beginPaneTelemetrySession("pane-1", "session-2");
    expect(usage.beginPaneUsageSession).toHaveBeenCalledWith(
      "pane-1",
      "session-2",
    );
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
  });
});
