import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import { findTeamByName, teamOfPane } from "./collection";
import { mapWorkspaceTeams, setMembership } from "./transforms";

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

describe("setMembership", () => {
  const base = () => [workspace("ws-1", [pane("pane-1"), pane("pane-2")])];

  it("writes a membership by team id, and touches no other pane", () => {
    const start = base();
    const next = setMembership(start, "ws-1", "pane-1", { teamId: "team-1", role: "lead" });
    expect(next[0].panes[0].team).toEqual({ teamId: "team-1", role: "lead" });
    expect(next[0].panes[1]).toBe(start[0].panes[1]);
  });

  it("deletes the key rather than leaving it undefined — the pane is serialized", () => {
    const on = setMembership(base(), "ws-1", "pane-1", { teamId: "team-1", role: "lead" });
    const off = setMembership(on, "ws-1", "pane-1", undefined);
    expect("team" in off[0].panes[0]).toBe(false);
  });

  it("returns the SAME array for a no-op, in every direction", () => {
    const start = base();
    expect(setMembership(start, "ws-1", "pane-1", undefined)).toBe(start);
    expect(setMembership(start, "ws-9", "pane-1", { teamId: "team-1", role: "lead" })).toBe(start);
    expect(setMembership(start, "ws-1", "pane-9", { teamId: "team-1", role: "lead" })).toBe(start);
    const on = setMembership(start, "ws-1", "pane-1", { teamId: "team-1", role: "lead" });
    expect(setMembership(on, "ws-1", "pane-1", { teamId: "team-1", role: "lead" })).toBe(on);
  });

  it("neither finds nor makes a team: an id names whatever the workspace holds, or nothing", () => {
    // The one thing the primitive does not do. A name-keyed write used to
    // mint a roster-only team here; a pane can now hold an id the workspace
    // has no team for, and every reader treats that as no membership.
    const next = setMembership(base(), "ws-1", "pane-1", { teamId: "team-9", role: "lead" });
    expect(next[0].teams).toBeUndefined();
    expect(teamOfPane(next[0], next[0].panes[0])).toBeUndefined();
  });
});

describe("mapWorkspaceTeams", () => {
  it("adds and drops, leaving the key off a workspace with no teams", () => {
    const base = [workspace("ws-1", [])];
    const team = { id: "team-1", name: "api" };
    const added = mapWorkspaceTeams(base, "ws-1", (teams) => [...teams, team]);
    expect(added[0].teams).toEqual([team]);
    // The same teams back is the same workspace back.
    expect(mapWorkspaceTeams(added, "ws-1", (teams) => teams)[0]).toBe(added[0]);
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
