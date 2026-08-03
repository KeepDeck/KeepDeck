import { describe, expect, it, vi } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import { createAgentStatusTracker } from "./agentStatusTracker";

const turnStart = (at: number): AgentStatusEvent => ({ kind: "turn-start", at });

/** A normalizer reading `{ agent, event: { kind } }` fixtures literally. */
const literal = (payload: unknown, at: number): AgentStatusEvent | null => {
  const event = (payload as { event?: { kind?: string } }).event;
  switch (event?.kind) {
    case "start":
      return turnStart(at);
    case "end":
      return { kind: "turn-end", at };
    case "helper-start":
      return { kind: "helper-start", at, id: "helper-1" };
    case "helper-end":
      return { kind: "helper-end", at, id: "helper-1" };
    default:
      return null;
  }
};

describe("agentStatusTracker", () => {
  it("folds a report through the registered normalizer into the snapshot", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 100);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 100,
    });
    tracker.report("pane-1", { agent: "claude", event: { kind: "end" } }, 200);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 200,
      interrupted: false,
    });
  });

  it("keeps the pane working while a helper's turn is open, silently", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const listener = vi.fn();
    tracker.subscribe(listener);

    const report = (kind: string, at: number) =>
      tracker.report("pane-1", { agent: "claude", event: { kind } }, at);

    report("start", 100);
    expect(listener).toHaveBeenCalledTimes(1);

    // The bracket is private state: opening it changes nothing anyone can
    // see, so it must not wake the subscribers or the notification
    // producers behind them.
    report("helper-start", 110);
    expect(listener).toHaveBeenCalledTimes(1);

    // The turn closes, but its helper has not — the pane keeps working,
    // with the TURN's age, and again nothing is announced.
    report("end", 120);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 100,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // Only once the helper is done does the next ending land.
    report("helper-end", 200);
    report("end", 210);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 210,
      interrupted: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clearing a pane retires the helpers it was still counting", () => {
    // Otherwise a restart would inherit brackets belonging to a process
    // that no longer exists, and the fresh pane could never reach "done".
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const report = (kind: string, at: number) =>
      tracker.report("pane-1", { agent: "claude", event: { kind } }, at);

    report("start", 100);
    report("helper-start", 110);
    tracker.clear("pane-1");

    report("start", 300);
    report("end", 310);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 310,
      interrupted: false,
    });
  });

  it("drops reports for unknown agents, malformed payloads and untracked events", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    tracker.report("pane-1", { agent: "codex", event: { kind: "start" } });
    tracker.report("pane-1", "not a record");
    tracker.report("pane-1", { agent: "claude", event: { kind: "mystery" } });
    expect(tracker.getSnapshot().panes.size).toBe(0);
  });

  it("notifies subscribers once per change with a fresh stable snapshot", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const listener = vi.fn();
    tracker.subscribe(listener);
    const before = tracker.getSnapshot();
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot()).not.toBe(before);
    const after = tracker.getSnapshot();
    // A dropped report changes nothing and must not churn the snapshot.
    tracker.report("pane-1", { agent: "claude", event: { kind: "mystery" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot()).toBe(after);
  });

  it("clear() starts a pane over; a missing pane is a no-op", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 100);
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.clear("pane-1");
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    tracker.clear("pane-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a report after clear() starts genuinely fresh", () => {
    // Pins the clear-is-total contract against a future soft-clear /
    // tombstone: the fold after a clear must see NO prior state.
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    tracker.report("pane-1", { agent: "claude", event: { kind: "end" } }, 100);
    tracker.clear("pane-1");
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 200);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 200,
    });
  });

  it("retain() drops only panes that no longer exist", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 100);
    tracker.report("pane-2", { agent: "claude", event: { kind: "start" } }, 100);
    tracker.retain(new Set(["pane-2"]));
    expect([...tracker.getSnapshot().panes.keys()]).toEqual(["pane-2"]);
    const stable = tracker.getSnapshot();
    tracker.retain(new Set(["pane-2"]));
    expect(tracker.getSnapshot()).toBe(stable);
  });

  it("a replacing registration wins; its unregister only removes itself", () => {
    const tracker = createAgentStatusTracker();
    const first = vi.fn().mockReturnValue(null);
    const unregisterFirst = tracker.registerNormalizer("claude", first);
    tracker.registerNormalizer("claude", literal);
    // Unregistering the SUPERSEDED normalizer must not evict the active one.
    unregisterFirst();
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 100);
    expect(first).not.toHaveBeenCalled();
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 100,
    });
  });
});
