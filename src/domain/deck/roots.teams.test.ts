import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import { paneBlock, paneHasProcess, paneSuspendBlock, type Pane } from "./panes";
import {
  paneBranch,
  paneExecutionCwd,
  panePlacement,
  paneProvisioning,
  paneWorktree,
  skillRootsOf,
} from "./roots";
import type { Team } from "./teams";
import { directoryState, firstFreeTeamWorktree, type Workspace } from "./workspaces";

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
const onRoot: Team = {
  id: "team-4",
  name: "root",
  location: { kind: "attached", cwd: "/repo", branch: "main" },
};

const member = (teamId: string, own?: Pane["location"]): Pane => ({
  id: `pane-${teamId}`,
  team: { teamId, role: "lead" },
  ...(own && { location: own }),
});

describe("panePlacement is the team's", () => {
  it("a member runs in its team's directory — a remote endpoint of its own changes nothing", () => {
    const workspace = ws({ teams: [owner] });
    expect(panePlacement(workspace, member("team-1"))).toEqual(owner.location);
    expect(paneExecutionCwd(workspace, member("team-1"))).toBe("/wt/team");
    expect(
      paneExecutionCwd(workspace, member("team-1", { kind: "remote", endpoint: "ws://vps" })),
    ).toBe("/wt/team");
    expect(paneBranch(workspace, member("team-1"))).toBe("kd/team");
  });

  it("a member of a team still creating its directory runs nowhere yet", () => {
    const workspace = ws({ teams: [creating] });
    expect(paneExecutionCwd(workspace, member("team-2"))).toBeNull();
    expect(paneBranch(workspace, member("team-2"))).toBeUndefined();
    expect(paneWorktree(workspace, member("team-2"))).toBeNull();
    // Skills staging arms no directory for it either.
    expect(skillRootsOf(ws({ teams: [creating], panes: [member("team-2")] }))).toEqual([]);
  });

  it("a member of a roster-only team, and a pane on no team, run in the workspace root", () => {
    // The transition's leftover: a team the mail minted by name holds no
    // directory; its members answer as the root, like a pane on no team.
    const workspace = ws({ teams: [rosterOnly] });
    expect(panePlacement(workspace, member("team-3"))).toEqual({ kind: "root" });
    expect(paneExecutionCwd(workspace, member("team-3"))).toBe("/repo");
    expect(paneBranch(workspace, member("team-3"))).toBeUndefined();
    expect(paneExecutionCwd(workspace, { id: "pane-9" })).toBe("/repo");
    expect(paneExecutionCwd(ws(), member("team-404"))).toBe("/repo");
    expect(paneBranch(workspace, { id: "pane-9", location: { kind: "remote", endpoint: "e" } })).toBeUndefined();
  });

  it("paneWorktree names a team's directory apart from the root, and nothing for the root", () => {
    const workspace = ws({ teams: [owner, onRoot] });
    expect(paneWorktree(workspace, member("team-1"))).toEqual({ cwd: "/wt/team", branch: "kd/team" });
    // The root's team runs in the root: a branch, but no worktree of its own.
    expect(paneBranch(workspace, member("team-4"))).toBe("main");
    expect(paneWorktree(workspace, member("team-4"))).toBeNull();
    expect(paneWorktree(ws({ cwd: "/repo/" , teams: [onRoot] }), member("team-4"))).toBeNull();
    expect(paneWorktree(workspace, { id: "pane-9" })).toBeNull();
  });
});

describe("occupancy is the team's", () => {
  it("a directory a team holds is the team's, however the path is spelled", () => {
    const deck = [ws({ teams: [owner, creating] })];
    expect(directoryState(deck, deck[0], "/wt/team")).toBe("worked-in");
    expect(directoryState(deck, deck[0], " /wt/team/ ")).toBe("worked-in");
    expect(directoryState(deck, deck[0], "/wt/pending")).toBe("being-created");
    expect(directoryState(deck, deck[0], "/wt/free")).toBe("free");
  });

  it("a team's directory is skipped when the next free worktree is suggested", async () => {
    const deck = [ws({ teams: [owner] })];
    const suggest = async (index: number) => ({ folder: index === 1 ? "team" : `free-${index}` , branch: `kd/${index}` });
    expect(await firstFreeTeamWorktree(deck, "/wt", suggest, 1)).toEqual({
      path: "/wt/free-2",
      branch: "kd/2",
    });
  });
});

describe("every placement question reads the team", () => {
  it("a member of a team whose create is in flight has no process, cannot be suspended, and wears the card", () => {
    // The pane's own record says nothing about a create; its team's does.
    // Every surface that asks "is this pane still being created" must get
    // the same answer from the same reading.
    const workspace = ws({ teams: [creating] });
    const pane = member("team-2");
    expect(paneProvisioning(workspace, pane)).toEqual(creating.location);
    expect(paneHasProcess(workspace, pane)).toBe(false);
    expect(paneSuspendBlock(workspace, pane, false)).toBe("provisioning");
    expect(paneBlock(workspace, pane, true)).toEqual({ kind: "provisioning" });
    // The same pane on a team that owns its directory is an ordinary pane.
    const landed = ws({ teams: [owner] });
    expect(paneProvisioning(landed, member("team-1"))).toBeNull();
    expect(paneHasProcess(landed, member("team-1"))).toBe(true);
    expect(paneSuspendBlock(landed, member("team-1"), false)).toBeNull();
  });

  it("a remote member is refused a suspend by name, whatever its team is doing", () => {
    const remote = member("team-1", { kind: "remote", endpoint: "ws://vps" });
    expect(paneSuspendBlock(ws({ teams: [owner] }), remote, false)).toBe("remote");
    expect(paneSuspendBlock(ws({ teams: [creating] }), { ...remote, team: { teamId: "team-2", role: "lead" } }, false)).toBe("remote");
  });
});
