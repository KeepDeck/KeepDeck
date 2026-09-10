import { describe, expect, it, vi } from "vitest";
import { watchMatches, watchProject } from "@keepdeck/plugin-api";
import { normalizeKimiStatus, renderKimiMail } from "../../plugins/kimi/src/status";
import { kimiRecords } from "../../plugins/kimi/src/tail";
import { createAgentStatusTracker } from "./agentStatusTracker";

function setup() {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer("kimi", normalizeKimiStatus);
  const hook = (name: string, at: number) => tracker.report("pane", {
    agent: "kimi", event: { hook_event_name: name, session_id: "shared" },
  }, at);
  const wire = (...rows: Record<string, unknown>[]) => {
    const records = rows.flatMap((row) => {
      const line = { agentId: "main", ...row };
      const watch = kimiRecords.watches.find((candidate) => watchMatches(candidate, line));
      return watch ? [watchProject(watch, line)] : [];
    });
    tracker.report("pane", { agent: "kimi", kind: "store.batch", records }, 9999);
  };
  return { tracker, hook, wire, activity: () => tracker.getSnapshot().panes.get("pane") };
}

describe("Kimi lifecycle through the real status tracker", () => {
  it.each([true, false])("waits for actual completion after Stop, delivered continuation=%s", (delivered) => {
    const { tracker, hook, wire, activity } = setup();
    hook("UserPromptSubmit", 100);
    const changed = vi.fn();
    tracker.subscribe(changed);
    const event = { hook_event_name: "Stop" };
    const pending = tracker.prepare("pane", { agent: "kimi", event }, 200);
    const reply = renderKimiMail({ event, messages: [{ id: "m", from: "lead", kind: "task", body: "Continue" }], cliVersion: null });
    pending.finish(delivered ? reply! : undefined);
    expect(activity()?.state).toBe("working");
    expect(changed).not.toHaveBeenCalled();
    // Kimi does not call Stop again after accepting its continuation.
    wire({ type: "turn.ended", time: 300, reason: "completed" });
    expect(activity()).toEqual({ state: "done", at: 300, interrupted: false });
  });

  it("a child's stop, cancellation or failure never closes the main turn", () => {
    const { hook, wire, activity } = setup();
    hook("UserPromptSubmit", 100);
    for (const event of ["Stop", "Interrupt", "StopFailure"]) hook(event, 200);
    wire({ type: "turn.ended", agentId: "child", time: 250, reason: "completed" });
    expect(activity()).toEqual({ state: "working", since: 100 });
    wire({ type: "turn.ended", time: 300, reason: "cancelled" });
    expect(activity()).toEqual({ state: "done", at: 300, interrupted: true });
  });

  it("a background notification starts real work without another human prompt", () => {
    const { tracker, hook, wire, activity } = setup();
    hook("UserPromptSubmit", 100);
    wire({ type: "turn.ended", time: 200, reason: "completed" });
    wire({ type: "turn.prompt", time: 300 });
    expect(activity()).toEqual({ state: "working", since: 300 });
    wire({ type: "turn.ended", time: 250, reason: "completed" });
    expect(activity()?.state).toBe("working");
    tracker.clear("pane");
    wire({ type: "turn.prompt", time: 400 });
    expect(activity()).toEqual({ state: "working", since: 400 });
  });

  it("holds an ending behind detached work and settles a wake atomically", () => {
    const { tracker, hook, wire, activity } = setup();
    hook("UserPromptSubmit", 100);
    const info = { taskId: "task-1", detached: true };
    wire({ type: "task.started", time: 150, info }, { type: "turn.ended", time: 200, reason: "completed" });
    expect(activity()?.state).toBe("working");
    const observed: string[] = [];
    tracker.subscribe(() => observed.push(activity()!.state));
    wire({ type: "task.terminated", time: 300, info }, { type: "turn.prompt", time: 300 });
    expect(observed).toEqual(["working"]);
    wire({ type: "turn.ended", time: 400, reason: "failed", error: { name: "rate_limit", message: "limited" } });
    expect(activity()).toEqual({ state: "failed", at: 400, error: "rate_limit", detail: "limited" });
  });
});
