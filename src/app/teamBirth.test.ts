import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { teamBirthBlock } from "./teamBirth";

const ws = (id: string, name: string, teams: { id: string; name: string; cwd: string }[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name,
  cwd: "/repo",
  worktreeBaseDir: "/wt",
  panes: [],
  teams: teams.map((team) => ({ id: team.id, name: team.name, location: { kind: "attached", cwd: team.cwd } })),
});

const here = ws("ws-1", "web", [{ id: "team-1", name: "api", cwd: "/wt/api" }]);
const there = ws("ws-2", "site", [{ id: "team-9", name: "root", cwd: "/repo" }]);
const deck = [here, there];

describe("teamBirthBlock", () => {
  it("stops at a name a team here answers to, before the machine is asked anything", async () => {
    const teamsIn = vi.fn(async () => []);
    expect(await teamBirthBlock({ ws: here, workspaces: deck, name: " api ", site: { kind: "root" }, teamsIn })).toEqual({
      kind: "taken",
      name: "api",
    });
    expect(teamsIn).not.toHaveBeenCalled();
  });

  it("names the team working in the folder, asking the machine about it as one spelling", async () => {
    const teamsIn = vi.fn(async () => ["team-1"]);
    expect(await teamBirthBlock({ ws: here, workspaces: deck, name: "second", site: { kind: "existing", cwd: "/wt/api/" }, teamsIn })).toEqual({
      kind: "shared",
      holder: { teamId: "team-1", teamName: "api" },
      path: "/wt/api",
    });
    expect(teamsIn).toHaveBeenCalledWith("/wt/api");
  });

  it("holds the root by this workspace's teams only, and leaves a new worktree's place to the machine", async () => {
    const teamsIn = vi.fn(async () => ["team-9"]);
    expect(await teamBirthBlock({ ws: here, workspaces: deck, name: "", site: { kind: "root" }, teamsIn })).toBeNull();
    expect(await teamBirthBlock({ ws: here, workspaces: deck, name: "", site: { kind: "new", place: null, base: null }, teamsIn })).toBeNull();
    expect(teamsIn).toHaveBeenCalledTimes(1);
  });
});
