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
    case "wait":
      return { kind: "waiting", at, reason: "permission" };
    case "agent-start":
      return { kind: "agent-turn-start", at, id: "agent-1" };
    case "agent-end":
      return { kind: "agent-turn-end", at, id: "agent-1" };
    case "agents-cleared":
      return { kind: "agent-turns-cleared", at };
    case "interrupt":
      return { kind: "interrupted", at };
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

  it("keeps the pane working while an agent turn is open, silently", () => {
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
    report("agent-start", 110);
    expect(listener).toHaveBeenCalledTimes(1);

    // The turn closes, but the agent's has not — the pane keeps working,
    // with the TURN's age, and again nothing is announced.
    report("end", 120);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 100,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // The last close settles the ending that was held back — no further
    // Stop is coming, so this is the edge that has to announce it.
    report("agent-end", 200);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 200,
      interrupted: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clearing a pane retires the agent turns it was still counting", () => {
    // Otherwise a restart would inherit brackets belonging to a process
    // that no longer exists, and the fresh pane could never reach "done".
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const report = (kind: string, at: number) =>
      tracker.report("pane-1", { agent: "claude", event: { kind } }, at);

    report("start", 100);
    report("agent-start", 110);
    tracker.clear("pane-1");

    report("start", 300);
    report("end", 310);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 310,
      interrupted: false,
    });
  });

  it("an interrupt releases the brackets, so the pane can finish again", () => {
    // The wiring for the orphan case: if the interrupt left the bracket
    // behind, the `end` below would be rewritten to a park and this pane
    // would report "working" for the rest of the process.
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const report = (kind: string, at: number) =>
      tracker.report("pane-1", { agent: "claude", event: { kind } }, at);

    report("start", 100);
    report("agent-start", 110);
    report("interrupt", 120);
    report("start", 200);
    report("end", 210);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 210,
      interrupted: false,
    });
  });

  it("a clearing edge settles the ending it was holding, through the tracker", () => {
    // The domain proves the fold; this proves the WIRING for the one edge
    // kind that reaches it only from an oversized payload, where the id did
    // not survive — the path least likely to be exercised by hand.
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const listener = vi.fn();
    tracker.subscribe(listener);
    const report = (kind: string, at: number) =>
      tracker.report("pane-1", { agent: "claude", event: { kind } }, at);

    report("start", 100);
    report("agent-start", 110);
    report("end", 120);
    expect(listener).toHaveBeenCalledTimes(1);

    report("agents-cleared", 400);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "done",
      at: 400,
      interrupted: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("retain keeps a surviving pane's open brackets, not just its activity", () => {
    // retain() rebuilds the map; a rebuild that reconstructed the state
    // field by field would drop the brackets and the pane would announce a
    // finished turn while its agents were still running.
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const report = (kind: string, at: number) =>
      tracker.report("pane-1", { agent: "claude", event: { kind } }, at);

    report("start", 100);
    report("agent-start", 110);
    tracker.retain(new Set(["pane-1"]));

    report("end", 120);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 100,
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

  it("retain() drops only panes that no longer exist, and says so once", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", literal);
    const listener = vi.fn();
    tracker.report("pane-1", { agent: "claude", event: { kind: "start" } }, 100);
    tracker.report("pane-2", { agent: "claude", event: { kind: "start" } }, 100);
    tracker.subscribe(listener);
    tracker.retain(new Set(["pane-2"]));
    expect([...tracker.getSnapshot().panes.keys()]).toEqual(["pane-2"]);
    // A pane leaving the roster IS a visible change — the visibility test
    // that keeps bracket churn silent must not swallow this one.
    expect(listener).toHaveBeenCalledTimes(1);
    const stable = tracker.getSnapshot();
    tracker.retain(new Set(["pane-2"]));
    expect(tracker.getSnapshot()).toBe(stable);
    expect(listener).toHaveBeenCalledTimes(1);
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

  it("an answer resolves a standing wait", () => {
    const tracker = createAgentStatusTracker();
    tracker.registerNormalizer("codex", literal);
    tracker.report("pane-1", { agent: "codex", event: { kind: "start" } }, 100);
    tracker.report("pane-1", { agent: "codex", event: { kind: "wait" } }, 200);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "waiting",
      since: 200,
      reason: "permission",
    });

    // The running phase restarts at the answer — the age reads "how long
    // since you could have walked away", and the wait is over now.
    tracker.answered("pane-1", 300);
    expect(tracker.getSnapshot().panes.get("pane-1")).toEqual({
      state: "working",
      since: 300,
    });
  });

  it("an answer never invents activity for a pane that reported none", () => {
    const tracker = createAgentStatusTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    // Typing into an idle shell. A bridge `resumed` legitimately WOULD start
    // a phase here (a tool completed, so something is running); this entry
    // point asks the domain instead, and nothing but this case holds the
    // tracker to asking. The states it declines beyond this one are the
    // reducer's own business, covered in domain/status/activity.test.ts.
    tracker.answered("pane-1", 100);
    expect(tracker.getSnapshot().panes.has("pane-1")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
