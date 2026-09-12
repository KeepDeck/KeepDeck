import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import { membersOn, rosterChanges, rosterOf } from "./membership";

const workspace = (id: string, panes: Pane[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: `/${id}`,
  worktreeBaseDir: null,
  panes,
});

const on = (id: string, teamId: string, role: string): Pane => ({
  id,
  agentType: "claude",
  team: { teamId, role },
});

describe("rosterOf", () => {
  it("reads every teamed pane and skips the rest", () => {
    const roster = rosterOf([
      workspace("ws-1", [on("pane-1", "team-1", "lead"), { id: "pane-2", agentType: "claude" }]),
      workspace("ws-2", [on("pane-3", "team-2", "impl-1")]),
    ]);
    expect([...roster.entries()]).toEqual([
      ["pane-1", { workspaceId: "ws-1", teamId: "team-1", role: "lead" }],
      ["pane-3", { workspaceId: "ws-2", teamId: "team-2", role: "impl-1" }],
    ]);
  });
});

describe("rosterChanges", () => {
  const before = rosterOf([
    workspace("ws-1", [on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]),
  ]);

  it("names nothing when nothing moved — a title change is not a roster change", () => {
    const same = rosterOf([
      workspace("ws-1", [
        { ...on("pane-1", "team-1", "lead"), name: "renamed" },
        on("pane-2", "team-1", "impl-1"),
      ]),
    ]);
    expect(rosterChanges(before, same)).toEqual([]);
  });

  it("names the team a member joined", () => {
    const after = rosterOf([
      workspace("ws-1", [
        on("pane-1", "team-1", "lead"),
        on("pane-2", "team-1", "impl-1"),
        on("pane-3", "team-1", "impl-2"),
      ]),
    ]);
    expect(rosterChanges(before, after)).toEqual([{ workspaceId: "ws-1", teamId: "team-1" }]);
  });

  it("names the team a member left", () => {
    const after = rosterOf([workspace("ws-1", [on("pane-1", "team-1", "lead")])]);
    expect(rosterChanges(before, after)).toEqual([{ workspaceId: "ws-1", teamId: "team-1" }]);
  });

  it("names the team whose member changed role, once", () => {
    const after = rosterOf([
      workspace("ws-1", [on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "reviewer-1")]),
    ]);
    expect(rosterChanges(before, after)).toEqual([{ workspaceId: "ws-1", teamId: "team-1" }]);
  });

  it("names BOTH teams when a member moves between them", () => {
    // Each roster stopped saying what it said: one lost a member, one gained.
    const after = rosterOf([
      workspace("ws-1", [on("pane-1", "team-1", "lead"), on("pane-2", "team-2", "impl-1")]),
    ]);
    expect(rosterChanges(before, after)).toEqual([
      { workspaceId: "ws-1", teamId: "team-1" },
      { workspaceId: "ws-1", teamId: "team-2" },
    ]);
  });
});

describe("membersOn", () => {
  it("lists the panes standing on the named teams, in roster order", () => {
    const roster = rosterOf([
      workspace("ws-1", [
        on("pane-1", "team-1", "lead"),
        on("pane-2", "team-2", "lead"),
        on("pane-3", "team-1", "impl-1"),
      ]),
    ]);
    expect(membersOn(roster, [{ workspaceId: "ws-1", teamId: "team-1" }])).toEqual([
      "pane-1",
      "pane-3",
    ]);
    expect(membersOn(roster, [])).toEqual([]);
  });
});
