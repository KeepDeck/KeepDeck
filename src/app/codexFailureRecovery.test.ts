import { describe, expect, it } from "vitest";
import { watchMatches, watchProject } from "@keepdeck/plugin-api";
import { normalizeCodexStatus } from "../../plugins/codex/src/status";
import { codexRecords } from "../../plugins/codex/src/tail";
import { activityBadge } from "../domain/status/format";
import { createAgentStatusTracker } from "./agentStatusTracker";

// Codex 0.153.2, 2026-09-08: the usage-limit turn had no Stop hook.
// task_complete carried the error; ids/prose shortened, shape preserved.
const failedAt = Date.parse("2026-09-08T21:38:11.107Z");
const terminal = {
  timestamp: "2026-09-08T21:38:11.107Z",
  type: "event_msg",
  payload: {
    type: "task_complete", turn_id: "turn-1", last_agent_message: null,
    error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" },
  },
};

function setup() {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer("codex", normalizeCodexStatus);
  const hook = (name: string, at: number) => tracker.report("pane", {
    agent: "codex", event: { hook_event_name: name },
  }, at);
  const tail = () => {
    const watch = codexRecords.watches.find((candidate) => watchMatches(candidate, terminal));
    expect(watch).toBeDefined();
    tracker.report("pane", {
      agent: "codex", kind: "store.record", record: watchProject(watch!, terminal),
    }, failedAt + 2000);
  };
  return { tracker, hook, tail };
}

describe("Codex terminal failures through the status lane", () => {
  it("leaves working on a usage limit, and recovers only on a new prompt", () => {
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", failedAt - 1000);
    tail();
    const failed = tracker.getSnapshot().panes.get("pane")!;
    expect(activityBadge(failed)).toMatchObject({ tone: "failed", label: "Rate limited" });
    expect(failed).toMatchObject({ at: failedAt, detail: "You've hit your usage limit." });
    hook("PostToolUse", failedAt + 2100);
    hook("Stop", failedAt + 2200);
    expect(tracker.getSnapshot().panes.get("pane")).toBe(failed);
    hook("UserPromptSubmit", failedAt + 3000);
    expect(tracker.getSnapshot().panes.get("pane")?.state).toBe("working");
  });

  it("does not fail a newer turn when the rollout arrives late", () => {
    const { tracker, hook, tail } = setup();
    hook("UserPromptSubmit", failedAt + 1000);
    const before = tracker.getSnapshot();
    tail();
    expect(tracker.getSnapshot()).toBe(before);
  });
});
