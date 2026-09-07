import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { Team, Workspace } from "../../domain/deck";
import { deletableWorktrees, existingTargets } from "./teardownTargets";

const team = (id: string, cwd: string, branch?: string): Team => ({
  id,
  name: id,
  location: { kind: "attached", cwd, ...(branch && { branch }) },
});

const ws = (id: string, cwd: string, teams: Team[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd,
  worktreeBaseDir: null,
  panes: [],
  teams,
});

describe("deletableWorktrees", () => {
  it("collects what the ending teams hold, and never the workspace root", () => {
    const here = ws("ws-1", "/repo", [
      team("team-1", "/repo"),
      team("team-2", "/wt/2", "kd/2"),
    ]);
    expect(
      deletableWorktrees({
        workspaces: [here],
        workspace: here,
        root: "/repo",
        ending: ["team-1", "team-2"],
      }),
    ).toEqual([{ repo: "/repo", path: "/wt/2", branch: "kd/2" }]);
  });

  it("folds several teams in ONE directory into one target", () => {
    // `worktreeTargets` answers per TEAM — an invariant of the rule that a
    // directory was one team's. Two sharers made the dialog offer to delete
    // "2 worktrees" for one directory.
    const here = ws("ws-1", "/repo", [team("team-1", "/wt/2"), team("team-2", "/wt/2")]);
    const doomed = deletableWorktrees({
      workspaces: [here],
      workspace: here,
      root: "/repo",
      ending: ["team-1", "team-2"],
    });
    expect(doomed).toHaveLength(1);
    expect(doomed[0].path).toBe("/wt/2");
  });

  it("leaves a directory a surviving team still works in", () => {
    const here = ws("ws-1", "/repo", [team("team-1", "/wt/2"), team("team-2", "/wt/2")]);
    expect(
      deletableWorktrees({
        workspaces: [here],
        workspace: here,
        root: "/repo",
        ending: ["team-1"],
      }),
    ).toEqual([]);
  });

  it("counts a survivor in ANOTHER workspace — sharing crosses them", () => {
    const here = ws("ws-1", "/repo", [team("team-1", "/wt/2")]);
    const there = ws("ws-2", "/other", [team("team-9", "/wt/2")]);
    expect(
      deletableWorktrees({
        workspaces: [here, there],
        workspace: here,
        root: "/repo",
        ending: ["team-1"],
      }),
    ).toEqual([]);
  });

  it("does not let two concurrent closes spare a directory on each other's behalf", () => {
    // Both teams are leaving — one through this close, one through a close
    // already holding it. Without `alsoLeaving`, each sees the other as a
    // survivor and the worktree outlives both.
    const here = ws("ws-1", "/repo", [team("team-1", "/wt/2"), team("team-2", "/wt/2")]);
    expect(
      deletableWorktrees({
        workspaces: [here],
        workspace: here,
        root: "/repo",
        ending: ["team-1"],
        alsoLeaving: ["team-2"],
      }),
    ).toEqual([{ repo: "/repo", path: "/wt/2", branch: undefined }]);
  });

  it("takes the dialog's frozen list and the ticket's directory, under the same rules", () => {
    const here = ws("ws-1", "/repo", []);
    expect(
      deletableWorktrees({
        workspaces: [here],
        workspace: here,
        root: "/repo",
        ending: [],
        frozen: [{ repo: "/repo", path: "/wt/frozen", branch: "kd/f" }],
        created: [{ path: "/wt/made", branch: "kd/m" }, null],
      }).map((target) => target.path),
    ).toEqual(["/wt/frozen", "/wt/made"]);
  });

  it("contributes nothing from a workspace that is already gone, beyond what it was handed", () => {
    expect(
      deletableWorktrees({
        workspaces: [],
        workspace: undefined,
        root: "/repo",
        ending: ["team-1"],
        frozen: [{ repo: "/repo", path: "/wt/frozen", branch: undefined }],
      }).map((target) => target.path),
    ).toEqual(["/wt/frozen"]);
  });
});

describe("existingTargets", () => {
  const probe = (exists: boolean) => ({ exists, isWorktree: exists, empty: false, branch: null });

  it("drops what is not there, and KEEPS what could not be asked", async () => {
    const targets = [
      { repo: "/repo", path: "/wt/gone", branch: undefined },
      { repo: "/repo", path: "/wt/here", branch: undefined },
      { repo: "/repo", path: "/wt/unknown", branch: undefined },
    ];
    const answered = await existingTargets(targets, async (path) => {
      if (path === "/wt/unknown") throw new Error("ipc down");
      return probe(path === "/wt/here");
    });
    // A rejected probe is IPC trouble, not a missing path: degrade to
    // offering it rather than quietly shrinking what the close covers.
    expect(answered.map((t) => t.path)).toEqual(["/wt/here", "/wt/unknown"]);
  });
});
