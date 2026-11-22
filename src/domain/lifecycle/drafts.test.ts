import { describe, expect, it } from "vitest";
import { memberDraft, paneDraftOf, teamDraftOf, workspaceDraftOf } from "./drafts";

describe("the member a door asks for", () => {
  it("is written as a pane is kept: the name trimmed, a blank one none", () => {
    expect(memberDraft({ agentType: "claude", name: " api " }, "impl-1")).toEqual({ agentType: "claude", role: "impl-1", name: "api" });
    expect(memberDraft({ agentType: "claude", name: "   " }, "impl-1")).toEqual({ agentType: "claude", role: "impl-1" });
    expect(memberDraft({ agentType: "claude" }, "impl-1")).toEqual({ agentType: "claude", role: "impl-1" });
  });

  it("carries YOLO only when it is on — an explicit false is none", () => {
    expect(memberDraft({ agentType: "claude", yolo: true }, "impl-1")).toEqual({ agentType: "claude", role: "impl-1", yolo: true });
    expect(memberDraft({ agentType: "claude", yolo: false }, "impl-1")).toEqual({ agentType: "claude", role: "impl-1" });
  });

  it("carries a remote agent's location and the session it resumes as they are", () => {
    const location = { kind: "remote" as const, endpoint: "wss://vps" };
    expect(memberDraft({ agentType: "claude", location }, "lead", "s-1")).toEqual({ agentType: "claude", role: "lead", location, session: { id: "s-1" } });
  });
});

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
