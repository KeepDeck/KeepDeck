import { describe, expect, it, vi } from "vitest";
import { watchMatches, watchProject, type AgentHistory } from "@keepdeck/plugin-api";
import { kimiRecords, kimiTail } from "./tail";

const project = (record: Record<string, unknown>) => {
  const watch = kimiRecords.watches.find((candidate) => watchMatches(candidate, record));
  return watch ? watchProject(watch, record) : null;
};

describe("Kimi's main wire lifecycle", () => {
  it("carries only main-agent metadata, never prompts or task output", () => {
    expect(project({ type: "turn.prompt", agentId: "main", time: 100, input: ["private"] }))
      .toEqual({ type: "turn.prompt", agentId: "main", time: 100 });
    expect(project({ type: "turn.prompt", agentId: "agent-1", time: 100 })).toBeNull();
    expect(project({ type: "task.terminated", agentId: "main", time: 200,
      info: { taskId: "task-1", detached: true, description: "private" }, outputTail: "private" }))
      .toEqual({ type: "task.terminated", agentId: "main", time: 200, "info.taskId": "task-1", "info.detached": true });
  });

  it.each([
    ["completed", { kind: "turn-end", at: 200 }],
    ["cancelled", { kind: "interrupted", at: 200, scope: "main" }],
    ["blocked", { kind: "interrupted", at: 200, scope: "main" }],
    ["failed", { kind: "turn-failed", at: 200, error: "rate_limit", detail: "limited" }],
  ])("uses the actual %s ending", (reason, expected) => {
    const record = project({ type: "turn.ended", agentId: "main", time: 200, reason,
      error: { name: "rate_limit", message: "limited" } });
    expect(kimiRecords.read(record!)).toEqual(expected);
  });

  it("refuses malformed, undated, foreign and unknown endings", () => {
    for (const extra of [{ time: NaN }, { time: "200" }, { time: -1 }, { agentId: "child" }, { reason: "future" }]) {
      expect(kimiRecords.read({ type: "turn.ended", agentId: "main", time: 200, reason: "completed", ...extra })).toBeNull();
    }
    expect(kimiRecords.read({ type: "turn.ended", agentId: "main", time: 200, reason: "failed" }))
      .toEqual({ kind: "turn-failed", at: 200, error: "unknown" });
  });

  it("brackets only named detached tasks", () => {
    for (const type of ["task.started", "task.terminated"]) {
      const base = { type, agentId: "main", time: 200, "info.taskId": "task-1" };
      expect(kimiRecords.read({ ...base, "info.detached": true })?.kind)
        .toBe(type === "task.started" ? "agent-turn-start" : "agent-turn-end");
      expect(kimiRecords.read({ ...base, "info.detached": false })).toBeNull();
      expect(kimiRecords.read({ ...base, "info.detached": true, "info.taskId": "" })).toBeNull();
    }
  });

  it("uses the reported path or reuses history discovery for an exact resumed session", async () => {
    const listing = vi.fn(async () => ({ stubs: [{ sessionId: "session_one", ref: "/one/agents/main/wire.jsonl" }], complete: true }));
    const tail = kimiTail({ listing } as unknown as AgentHistory);
    expect(await tail.follow({ sessionId: "one", store: "/reported", cwd: null })).toEqual({ path: "/reported" });
    expect(listing).not.toHaveBeenCalled();
    expect(await tail.follow({ sessionId: null, store: null, cwd: null })).toBeNull();
    expect(await tail.follow({ sessionId: "one", store: null, cwd: null })).toEqual({ path: "/one/agents/main/wire.jsonl" });
    expect(await tail.follow({ sessionId: "unknown", store: null, cwd: null })).toBeNull();
  });
});
