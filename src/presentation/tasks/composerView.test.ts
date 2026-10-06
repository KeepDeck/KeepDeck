import { describe, expect, it } from "vitest";
import { TASK_CAPS } from "../../domain/tasks";
import { canCreateTask, canSendComment } from "./composerView";

describe("composer and form validity come from the domain", () => {
  it("a comment may be sent when the domain would accept it and nothing is in flight", () => {
    expect(canSendComment("  ", false)).toBe(false);
    expect(canSendComment("x", true)).toBe(false);
    expect(canSendComment("x", false)).toBe(true);
    expect(canSendComment("x".repeat(TASK_CAPS.commentMax + 1), false)).toBe(false);
  });

  it("a task may be created when the domain would accept its title and its brief", () => {
    expect(canCreateTask("", "")).toBe(false);
    expect(canCreateTask("  ", "")).toBe(false);
    expect(canCreateTask("x".repeat(TASK_CAPS.titleMax + 1), "")).toBe(false);
    expect(canCreateTask("Draft the skill", "")).toBe(true);
    // The brief has its own cap: past it, nothing is sent.
    expect(canCreateTask("Draft the skill", "x".repeat(TASK_CAPS.bodyMax + 1))).toBe(false);
    // Spaces round a title are not kept, so they do not count.
    expect(canCreateTask(`  ${"x".repeat(TASK_CAPS.titleMax)}  `, "")).toBe(true);
  });
});
