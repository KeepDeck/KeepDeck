import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import type { Pane } from "./panes";
import { paneBranch, paneExecutionCwd, skillRootsOf } from "./roots";
import type { Team } from "./teams";
import { firstFreeWorktree, pathOccupancy, type Workspace } from "./workspaces";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: "/wt",
  panes: [],
  ...over,
});

const owner: Team = {
  id: "team-1",
  name: "api",
  location: { kind: "attached", cwd: "/wt/team", branch: "kd/team" },
};
const creating: Team = {
  id: "team-2",
  name: "web",
  location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/pending", index: 2 } },
};
const rosterOnly: Team = { id: "team-3", name: "mail" };

const member = (teamId: string, own?: Pane["location"]): Pane => ({
  id: `pane-${teamId}`,
  team: { teamId, role: "lead" },
  ...(own && { location: own }),
});

describe("paneExecutionCwd reads the team first", () => {
  it("a member runs in its team's directory, whatever its own placement says", () => {
    // The pane's own placement is the transition's leftover; the team's
    // directory is the truth the moment the team owns one.
    const workspace = ws({ teams: [owner] });
    expect(paneExecutionCwd(workspace, member("team-1"))).toBe("/wt/team");
    expect(
      paneExecutionCwd(workspace, member("team-1", { kind: "attached", cwd: "/wt/own" })),
    ).toBe("/wt/team");
    expect(paneBranch(workspace, member("team-1", { kind: "main", branch: "own" }))).toBe(
      "kd/team",
    );
  });

  it("a member of a team still creating its directory runs nowhere yet", () => {
    const workspace = ws({ teams: [creating] });
    expect(paneExecutionCwd(workspace, member("team-2"))).toBeNull();
    expect(
      paneExecutionCwd(workspace, member("team-2", { kind: "attached", cwd: "/wt/own" })),
    ).toBeNull();
    expect(paneBranch(workspace, member("team-2", { kind: "main", branch: "own" }))).toBeUndefined();
    // Skills staging arms no directory for it either.
    expect(skillRootsOf(ws({ teams: [creating], panes: [member("team-2")] }))).toEqual([]);
  });

  it("a member of a roster-only team, and a pane on no team, answer for themselves", () => {
    const workspace = ws({ teams: [rosterOnly] });
    expect(paneExecutionCwd(workspace, member("team-3"))).toBe("/repo");
    expect(
      paneExecutionCwd(workspace, member("team-3", { kind: "attached", cwd: "/wt/own" })),
    ).toBe("/wt/own");
    expect(paneBranch(workspace, member("team-3", { kind: "main", branch: "own" }))).toBe("own");
    expect(paneExecutionCwd(workspace, { id: "pane-9" })).toBe("/repo");
    expect(paneBranch(workspace, { id: "pane-9", location: { kind: "attached", cwd: "/x" } })).toBeUndefined();
    expect(paneBranch(workspace, { id: "pane-9", location: { kind: "remote", endpoint: "e" } })).toBeUndefined();
  });

  it("a member whose id names no team here answers for itself", () => {
    expect(paneExecutionCwd(ws(), member("team-404"))).toBe("/repo");
  });
});

describe("occupancy is the team's", () => {
  it("a directory a team holds is occupied, however the path is spelled", () => {
    const deck = [ws({ teams: [owner, creating] })];
    expect(pathOccupancy(deck, "/wt/team")).toBe("worktree");
    expect(pathOccupancy(deck, " /wt/team/ ")).toBe("worktree");
    expect(pathOccupancy(deck, "/wt/pending")).toBe("provisioning");
    expect(pathOccupancy(deck, "/wt/free")).toBeNull();
  });

  it("a team's directory is skipped when the next free worktree is suggested", async () => {
    const deck = [ws({ teams: [owner] })];
    const suggest = async (index: number) => ({ folder: index === 1 ? "team" : `free-${index}` , branch: `kd/${index}` });
    expect(await firstFreeWorktree(deck, "/wt", suggest, 1)).toEqual({
      path: "/wt/free-2",
      branch: "kd/2",
    });
  });
});
