import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import { findTeamByName, membersOf, nextTeamSeq, teamNameOf, teamOfPane } from "./collection";
import { addTeam, assignPaneTeam, mapWorkspaceTeams } from "./transforms";

const pane = (id: string): Pane => ({ id, agentType: "claude" });

const workspace = (id: string, panes: Pane[], over: Partial<Workspace> = {}): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: `/${id}`,
  worktreeBaseDir: null,
  panes,
  ...over,
});

describe("assignPaneTeam", () => {
  it("mints a team for a name nobody holds, and the pane holds its id", () => {
    const next = assignPaneTeam(
      [workspace("ws-1", [pane("pane-1")])],
      "ws-1",
      "pane-1",
      { name: "api", role: "lead" },
    );
    expect(next[0].teams).toEqual([{ id: "team-1", name: "api" }]);
    expect(next[0].panes[0].team).toEqual({ teamId: "team-1", role: "lead" });
  });

  it("puts a second member on the SAME team by name, however it is spelled", () => {
    // The person typing "API" means the team they called "api": one team,
    // one id, two members — never two teams a key apart.
    let list = [workspace("ws-1", [pane("pane-1"), pane("pane-2")])];
    list = assignPaneTeam(list, "ws-1", "pane-1", { name: "api", role: "lead" });
    list = assignPaneTeam(list, "ws-1", "pane-2", { name: " API ", role: "impl-1" });
    expect(list[0].teams).toHaveLength(1);
    expect(membersOf(list[0], "team-1").map((p) => p.id)).toEqual(["pane-1", "pane-2"]);
    expect(teamNameOf(list[0], list[0].panes[1])).toBe("api");
  });

  it("mints ids across the whole deck, so two workspaces never share one", () => {
    let list = [workspace("ws-1", [pane("pane-1")]), workspace("ws-2", [pane("pane-2")])];
    list = assignPaneTeam(list, "ws-1", "pane-1", { name: "api", role: "lead" });
    list = assignPaneTeam(list, "ws-2", "pane-2", { name: "api", role: "lead" });
    expect(list[0].teams).toEqual([{ id: "team-1", name: "api" }]);
    expect(list[1].teams).toEqual([{ id: "team-2", name: "api" }]);
    expect(nextTeamSeq(list)).toBe(3);
  });

  it("takes the last member's roster-only team with it", () => {
    // A team that exists as a roster alone IS the panes holding it; with
    // nobody left it is a name nobody can be addressed by, and keeping it
    // would let a later create read as an edit of a ghost.
    let list = [workspace("ws-1", [pane("pane-1")])];
    list = assignPaneTeam(list, "ws-1", "pane-1", { name: "api", role: "lead" });
    list = assignPaneTeam(list, "ws-1", "pane-1", null);
    expect(list[0].teams).toBeUndefined();
    expect(list[0].panes[0].team).toBeUndefined();
  });

  it("keeps a team that owns a directory, empty or not", () => {
    // The directory is what the team is for; a roster of nobody does not
    // make it stop existing, and nothing here may delete a directory.
    const owner = workspace("ws-1", [pane("pane-1")], {
      teams: [{ id: "team-4", name: "api", location: { kind: "attached", cwd: "/wt/1" } }],
    });
    let list = assignPaneTeam([owner], "ws-1", "pane-1", { name: "api", role: "lead" });
    expect(list[0].panes[0].team).toEqual({ teamId: "team-4", role: "lead" });
    list = assignPaneTeam(list, "ws-1", "pane-1", null);
    expect(list[0].teams).toEqual(owner.teams);
  });

  it("moving a pane between teams prunes the one it left, when roster-only", () => {
    let list = [workspace("ws-1", [pane("pane-1"), pane("pane-2")])];
    list = assignPaneTeam(list, "ws-1", "pane-1", { name: "api", role: "lead" });
    list = assignPaneTeam(list, "ws-1", "pane-2", { name: "web", role: "lead" });
    list = assignPaneTeam(list, "ws-1", "pane-1", { name: "web", role: "impl-1" });
    expect(list[0].teams?.map((t) => t.name)).toEqual(["web"]);
    expect(list[0].panes.map((p) => p.team?.teamId)).toEqual(["team-2", "team-2"]);
  });

  it("returns the SAME array for a no-op, in every direction", () => {
    const base = [workspace("ws-1", [pane("pane-1")])];
    expect(assignPaneTeam(base, "ws-1", "pane-1", null)).toBe(base);
    expect(assignPaneTeam(base, "ws-9", "pane-1", { name: "api", role: "lead" })).toBe(base);
    expect(assignPaneTeam(base, "ws-1", "pane-9", { name: "api", role: "lead" })).toBe(base);
    const on = assignPaneTeam(base, "ws-1", "pane-1", { name: "api", role: "lead" });
    expect(assignPaneTeam(on, "ws-1", "pane-1", { name: "api", role: "lead" })).toBe(on);
  });

  it("changes only the role when the team is the same", () => {
    let list = [workspace("ws-1", [pane("pane-1")])];
    list = assignPaneTeam(list, "ws-1", "pane-1", { name: "api", role: "lead" });
    const again = assignPaneTeam(list, "ws-1", "pane-1", { name: "api", role: "impl-1" });
    expect(again[0].teams).toBe(list[0].teams);
    expect(again[0].panes[0].team).toEqual({ teamId: "team-1", role: "impl-1" });
  });
});

describe("addTeam and mapWorkspaceTeams", () => {
  it("adds once, and leaves the key off a workspace with no teams", () => {
    const base = [workspace("ws-1", [])];
    const team = { id: "team-1", name: "api" };
    const added = addTeam(base, "ws-1", team);
    expect(added[0].teams).toEqual([team]);
    expect(addTeam(added, "ws-1", team)[0]).toBe(added[0]);
    const emptied = mapWorkspaceTeams(added, "ws-1", () => []);
    expect("teams" in emptied[0]).toBe(false);
  });

  it("resolves a pane to its team, or to nothing for a dangling id", () => {
    const ws = workspace("ws-1", [{ ...pane("pane-1"), team: { teamId: "team-9", role: "lead" } }], {
      teams: [{ id: "team-1", name: "api" }],
    });
    expect(teamOfPane(ws, ws.panes[0])).toBeUndefined();
    expect(findTeamByName(ws, "API")?.id).toBe("team-1");
  });
});
