import { describe, expect, it } from "vitest";
import { watchMatches, watchProject } from "@keepdeck/plugin-api";
import { normalizeClaudeStatus } from "../../plugins/claude/src/status";
import { claudeTail } from "../../plugins/claude/src/tail";
import { createAgentStatusTracker } from "./agentStatusTracker";

const iso = (at: number) => new Date(at).toISOString();
const interrupt = (at: number) => ({
  type: "user", timestamp: iso(at), interruptedMessageId: "old-message", promptId: "new-prompt",
});
const accepted = (at: number) => ({
  type: "user", timestamp: iso(at), origin: { kind: "human" }, promptSource: "queued",
  promptId: "new-prompt", message: { content: "private prompt" },
});

function setup() {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer("claude", normalizeClaudeStatus);
  const hook = (name: string, at: number, fields: Record<string, unknown> = {}) => tracker.report("pane", {
    agent: "claude", event: { hook_event_name: name, ...fields },
  }, at);
  const tail = (records: Record<string, unknown>[]) => tracker.report("pane", {
    agent: "claude", kind: "store.batch", records: records.flatMap((record) => {
      const watch = claudeTail.watches.find((candidate) => watchMatches(candidate, record));
      return watch ? [watchProject(watch, record)] : [];
    }),
  }, 9000);
  return { tracker, hook, tail };
}

describe("Claude queued hard steering", () => {
  it("folds cancellation and the accepted next prompt without publishing done", () => {
    // Real 2.1.263/2.1.266 order: UPS for the queue precedes the OLD abort;
    // abort and accepted next prompt carry the SAME mutable promptId.
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", 100);
    hook("UserPromptSubmit", 200);
    const states: string[] = [];
    tracker.subscribe(() => states.push(tracker.getSnapshot().panes.get("pane")!.state));
    tail([interrupt(300), accepted(307)]);
    expect(tracker.getSnapshot().panes.get("pane")).toEqual({ state: "working", since: 307 });
    expect(states).toEqual(["working"]);
    hook("PostToolUse", 400);
    hook("Stop", 500);
    expect(tracker.getSnapshot().panes.get("pane")).toEqual({ state: "done", at: 500, interrupted: false });
  });

  it("recovers if the accepted prompt arrives on the next poll", () => {
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", 100);
    tail([interrupt(300)]);
    expect(tracker.getSnapshot().panes.get("pane")).toMatchObject({ state: "done", interrupted: true });
    tail([accepted(307)]);
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
    // A duplicate old marker arriving later cannot end that work again.
    tail([interrupt(300)]);
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
  });

  it("preserves file order even when two records share a millisecond", () => {
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", 100);
    tail([interrupt(300), accepted(300)]);
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
  });

  it("keeps an independently running agent alive across main cancellation", () => {
    // Live Claude 2.1.266: Esc cancels main Bash, but the background agent
    // completes later, closes its bracket, then wakes the main loop.
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", 100);
    hook("SubagentStart", 200, { agent_id: "background" });
    tail([interrupt(300)]);
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
    hook("PostToolUse", 400, { agent_id: "background" });
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
    hook("SubagentStop", 500, { agent_id: "background" });
    expect(tracker.getSnapshot().panes.get("pane")).toEqual({ state: "done", at: 500, interrupted: true });
    hook("UserPromptSubmit", 600);
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
    hook("Stop", 700, { background_tasks: [] });
    expect(tracker.getSnapshot().panes.get("pane")).toEqual({ state: "done", at: 700, interrupted: false });
  });

  it("does not revive a completed turn or clear a newer permission wait", () => {
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", 100);
    hook("Stop", 500);
    const done = tracker.getSnapshot();
    tail([accepted(200)]);
    expect(tracker.getSnapshot()).toBe(done);
    hook("UserPromptSubmit", 600);
    tracker.report("pane", { agent: "claude", event: {
      hook_event_name: "Notification", notification_type: "permission_prompt",
    } }, 800);
    const waiting = tracker.getSnapshot();
    tail([accepted(700)]);
    expect(tracker.getSnapshot()).toBe(waiting);
  });

  it("rejects tool results, metadata, sidechains and queue entries as starts", () => {
    const { tracker, hook, tail } = setup();
    hook("Stop", 100);
    const before = tracker.getSnapshot();
    tail([
      { type: "user", timestamp: iso(200), message: { content: [{ type: "tool_result" }] } },
      { ...accepted(200), isMeta: true },
      { ...accepted(200), isSidechain: true },
      { ...interrupt(200), isSidechain: true },
      { ...accepted(200), origin: { kind: "agent" } },
      { ...accepted(200), promptSource: "future" },
      { type: "queue-operation", timestamp: iso(200) },
    ]);
    expect(tracker.getSnapshot()).toBe(before);
  });
});
