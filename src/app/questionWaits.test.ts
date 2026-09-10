import { describe, expect, it, vi } from "vitest";
import { watchMatches, watchProject, type StatusNormalizer, type TailWatch } from "@keepdeck/plugin-api";
import { normalizeCodexStatus } from "../../plugins/codex/src/status";
import { codexRecords } from "../../plugins/codex/src/tail";
import { normalizeKimiStatus } from "../../plugins/kimi/src/status";
import { kimiRecords } from "../../plugins/kimi/src/tail";
import { createAgentStatusTracker } from "./agentStatusTracker";

const stamp = (at: number) => new Date(at).toISOString();
const mode = (at: number, value: unknown = "plan") => ({
  type: "turn_context", timestamp: stamp(at), payload: { collaboration_mode: { mode: value } },
});
const codexCall = (id: string, at: number, name = "request_user_input") => ({
  type: "response_item", timestamp: stamp(at), payload: { type: "function_call", name, call_id: id, arguments: "private questions" },
});
const codexAnswer = (id: string, at: number) => ({
  type: "response_item", timestamp: stamp(at), payload: { type: "function_call_output", call_id: id, output: "private answer" },
});
const kimiCall = (id: string, at: number, background = false, agentId = "main") => ({
  type: "context.append_loop_event", time: at, agentId,
  event: { type: "tool.call", name: "AskUserQuestion", toolCallId: id, args: { background, questions: "private questions" } },
});
const kimiAnswer = (id: string, at: number, agentId = "main") => ({
  type: "context.append_loop_event", time: at, agentId,
  event: { type: "tool.result", toolCallId: id, result: { output: "private answer" } },
});

function setup(agent: string, normalize: StatusNormalizer, watches: readonly TailWatch[]) {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer(agent, normalize);
  const hook = (name: string, at: number) => tracker.report("pane", {
    agent, event: { hook_event_name: name, agent_id: "main" },
  }, at);
  const records = (rows: readonly Record<string, unknown>[]) => rows.flatMap((row) => {
    const watch = watches.find((candidate) => watchMatches(candidate, row));
    return watch ? [watchProject(watch, row)] : [];
  });
  const wire = (...rows: Record<string, unknown>[]) => tracker.report("pane", { agent, kind: "store.batch", records: records(rows) }, 9999);
  return { tracker, hook, wire, records, activity: () => tracker.getSnapshot().panes.get("pane") };
}

describe.each([
  { agent: "codex", normalize: normalizeCodexStatus, watches: codexRecords.watches, call: codexCall, answer: codexAnswer,
    init: [mode(100)], permissionAnswer: "PostToolUse",
    ending: { type: "event_msg", timestamp: stamp(400), payload: { type: "turn_aborted" } } },
  { agent: "kimi", normalize: normalizeKimiStatus, watches: kimiRecords.watches, call: kimiCall, answer: kimiAnswer,
    init: [], permissionAnswer: "PermissionResult",
    ending: { type: "turn.ended", agentId: "main", time: 400, reason: "cancelled" } },
])("$agent question lifecycle", ({ agent, normalize, watches, call, answer, init, permissionAnswer, ending }) => {
  it("waits for all matching answers, ignoring typing and unrelated tools/permissions", () => {
    const { tracker, hook, wire, activity } = setup(agent, normalize, watches);
    hook("UserPromptSubmit", 100);
    wire(...init, call("one", 200), call("two", 210));
    expect(activity()).toEqual({ state: "waiting", since: 200, reason: "question" });
    tracker.answered("pane", 220);
    hook(permissionAnswer, 230);
    wire(answer("other", 240), answer("one", 250));
    expect(activity()?.state).toBe("waiting");
    wire(answer("two", 260));
    expect(activity()).toEqual({ state: "working", since: 260 });
    wire(answer("two", 270));
    expect(activity()).toEqual({ state: "working", since: 260 });
  });

  it("a completed call in one drain never flashes waiting", () => {
    const { tracker, hook, wire, activity } = setup(agent, normalize, watches);
    hook("UserPromptSubmit", 100);
    wire(...init);
    const changed = vi.fn();
    tracker.subscribe(changed);
    wire(call("one", 200), answer("one", 210));
    expect(activity()).toEqual({ state: "working", since: 210 });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("steering retires old questions; a delayed old call or cancellation cannot poison the new wait", () => {
    const { hook, wire, activity } = setup(agent, normalize, watches);
    hook("UserPromptSubmit", 100);
    wire(...init, call("old", 200), ending);
    expect(activity()).toMatchObject({ state: "done", interrupted: true });
    hook("UserPromptSubmit", 500);
    wire(call("late", 300), call("new", 600), ending, answer("old", 650), answer("new", 700));
    expect(activity()).toEqual({ state: "working", since: 700 });
  });

  it("projects no question or answer text and rejects malformed ids/times", () => {
    const { hook, wire, records, activity } = setup(agent, normalize, watches);
    hook("UserPromptSubmit", 100);
    wire(...init, call("", 200));
    expect(activity()?.state).toBe("working");
    expect(JSON.stringify(records([call("one", 200), answer("one", 210)]))).not.toContain("private");
    const bad = { ...call("one", 200), timestamp: "bad time", time: NaN };
    wire(bad);
    expect(activity()?.state).toBe("working");
  });
});

describe("Codex collaboration mode", () => {
  it("seeds a resumed pane from metadata without replaying activity", () => {
    const { tracker, hook, wire, records, activity } = setup("codex", normalizeCodexStatus, codexRecords.watches);
    tracker.report("pane", { agent: "codex", kind: "store.record", contextOnly: true, record: records([mode(50)])[0] });
    expect(activity()).toBeUndefined();
    hook("UserPromptSubmit", 100);
    wire(codexCall("one", 200));
    expect(activity()?.state).toBe("waiting");
    wire(codexAnswer("one", 210));
    hook("UserPromptSubmit", 300);
    wire(mode(300, "default"), codexCall("two", 400));
    expect(activity()?.state).toBe("working");
    // Late context cannot restore Plan, and async questions never block.
    wire(mode(200), codexCall("three", 410), mode(420), codexCall("async", 430, "request_user_input_async"));
    expect(activity()?.state).toBe("working");
  });

  it.each([undefined, "default", "unknown"])("does not guess that mode %s is blocking", (value) => {
    const { hook, wire, activity } = setup("codex", normalizeCodexStatus, codexRecords.watches);
    hook("UserPromptSubmit", 100);
    if (value !== undefined) wire(mode(100, value));
    wire(codexCall("one", 200));
    expect(activity()?.state).toBe("working");
  });
});

it("Kimi background and child questions never park or resolve the main pane", () => {
  const { hook, wire, activity } = setup("kimi", normalizeKimiStatus, kimiRecords.watches);
  hook("UserPromptSubmit", 100);
  wire(kimiCall("background", 200, true), kimiCall("child", 210, false, "child"));
  expect(activity()?.state).toBe("working");
  wire(kimiCall("main", 220), kimiAnswer("main", 230, "child"), kimiAnswer("background", 240));
  expect(activity()?.state).toBe("waiting");
  wire(kimiAnswer("main", 250));
  expect(activity()).toEqual({ state: "working", since: 250 });
});
