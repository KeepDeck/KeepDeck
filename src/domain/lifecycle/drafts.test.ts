import { describe, expect, it } from "vitest";
import { paneDraftOf, teamDraftOf, workspaceDraftOf } from "./drafts";

describe("a draft read back from the machine", () => {
  it("is the workspace the page drafted, or nothing", () => {
    expect(workspaceDraftOf({ name: "app", cwd: "/repo", worktreeBaseDir: null })).toEqual({ name: "app", cwd: "/repo", worktreeBaseDir: null });
    expect(workspaceDraftOf({ name: "app", cwd: "/repo", worktreeBaseDir: "/wt" })?.worktreeBaseDir).toBe("/wt");
    expect(workspaceDraftOf({ name: "app", cwd: "/repo" })).toBeNull();
    expect(workspaceDraftOf({ name: 1, cwd: "/repo", worktreeBaseDir: null })).toBeNull();
  });

  it("is the team the page drafted, or nothing", () => {
    expect(teamDraftOf({ name: "api" })).toEqual({ name: "api" });
    expect(teamDraftOf(null)).toBeNull();
  });

  it("is the pane the page drafted, every field it carries checked, or nothing", () => {
    const full = { agentType: "claude", role: "lead", name: "A", yolo: true, location: { kind: "remote", endpoint: "http://vps" }, session: { id: "s-1" } };
    expect(paneDraftOf(full)).toEqual(full);
    expect(paneDraftOf({ agentType: "claude", role: "lead" })).toEqual({ agentType: "claude", role: "lead" });
    expect(paneDraftOf({ agentType: "claude" })).toBeNull();
    expect(paneDraftOf({ ...full, yolo: "yes" })).toBeNull();
    expect(paneDraftOf({ ...full, location: { kind: "local" } })).toBeNull();
    expect(paneDraftOf({ ...full, session: {} })).toBeNull();
  });
});
