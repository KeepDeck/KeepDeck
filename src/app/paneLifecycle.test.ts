import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaneLifecycle,
  type LifecycleAttribution,
  type LifecycleTracker,
  type LifecycleUsage,
} from "./paneLifecycle";

const usage = {
  clearPane: vi.fn<LifecycleUsage["clearPane"]>(),
  beginPaneSession: vi.fn<LifecycleUsage["beginPaneSession"]>(),
} satisfies LifecycleUsage;

const tracker = { clear: vi.fn<LifecycleTracker["clear"]>() } satisfies LifecycleTracker;

const attribution = {
  retire: vi.fn<LifecycleAttribution["retire"]>(),
} satisfies LifecycleAttribution;

describe("paneLifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retires EVERY holder — the set diverging is the bug this owner exists for", () => {
    createPaneLifecycle(usage, tracker, attribution).retire("pane-1");
    expect(usage.clearPane).toHaveBeenCalledWith("pane-1");
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
    expect(attribution.retire).toHaveBeenCalledWith("pane-1");
  });

  it("a new session generation restarts both telemetry stores", () => {
    createPaneLifecycle(usage, tracker, attribution).beginSession(
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
    createPaneLifecycle(usage, tracker, attribution).beginSession(
      "pane-1",
      "session-2",
    );
    expect(attribution.retire).not.toHaveBeenCalled();
  });

  it("ending a session clears both telemetry stores, re-briefs, and keeps the process pinned", () => {
    // opencode's /new before the first prompt: no next session yet, so the
    // deck is told the agent remembers nothing NOW — the next binding has no
    // previous session to differ from and would say nothing. The process is
    // still the pane's own, and its next session must not read as foreign.
    const began = vi.fn();
    createPaneLifecycle(usage, tracker, attribution, () => null, began).endSession("pane-1");
    expect(usage.clearPane).toHaveBeenCalledWith("pane-1");
    expect(tracker.clear).toHaveBeenCalledWith("pane-1");
    expect(began).toHaveBeenCalledWith("pane-1");
    expect(attribution.retire).not.toHaveBeenCalled();
  });
});
