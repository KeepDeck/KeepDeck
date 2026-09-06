import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import type { Workspace } from "./workspaces";
import type { Pane } from "./panes";
import type { Team } from "./teams";
import {
  pathBelongsTo,
  skillRootsOf,
  workspaceDirectories,
  withHistoricalDirectories,
} from "./roots";

const ws = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

/** A team attached to `cwd` and its one member: the directory is the
 * team's, and the pane runs in it. */
const teamed = (id: string, cwd: string): { team: Team; pane: Pane } => ({
  team: { id: `team-${id}`, name: id, location: { kind: "attached", cwd } },
  pane: { id, team: { teamId: `team-${id}`, role: "lead" } },
});
/** A workspace whose teams hold the given directories, one member each. */
const holding = (over: Partial<Workspace>, dirs: [string, string][]): Workspace => {
  const members = dirs.map(([id, cwd]) => teamed(id, cwd));
  return ws({
    ...over,
    teams: members.map((entry) => entry.team),
    panes: members.map((entry) => entry.pane),
  });
};

describe("workspaceDirectories", () => {
  it("a shared base root brings no foreign folder in", () => {
    // Three workspaces plant worktrees under ONE base — the base is only a
    // suggestion of where worktrees may land, never a folder source: each
    // workspace's set holds its own cwd and its own teams' folders, and
    // none of the siblings'.
    const base = "/wt";
    const a = holding(
      { id: "a", cwd: "/repo/a", worktreeBaseDir: base },
      [["p1", `${base}/kd-a-1`], ["p2", `${base}/kd-a-2`]],
    );
    const b = holding({ id: "b", cwd: "/repo/b", worktreeBaseDir: base }, [["p3", `${base}/kd-b-1`]]);
    const c = ws({ id: "c", cwd: "/repo/c", worktreeBaseDir: base, panes: [] });

    const setA = workspaceDirectories(a);
    expect([...setA].sort()).toEqual(["/repo/a", "/wt/kd-a-1", "/wt/kd-a-2"]);
    expect(pathBelongsTo(setA, "/wt/kd-b-1")).toBe(false);
    expect(pathBelongsTo(setA, "/repo/b")).toBe(false);
    expect(pathBelongsTo(workspaceDirectories(b), "/wt/kd-a-1")).toBe(false);
    expect([...workspaceDirectories(c)].sort()).toEqual(["/repo/c"]);
    // The base root itself is nobody's folder unless a team runs in it.
    for (const set of [setA, workspaceDirectories(b)]) {
      expect(pathBelongsTo(set, base)).toBe(false);
    }
  });

  it("membership is an exact path, not a stem", () => {
    const set = workspaceDirectories(holding({ cwd: "/repo" }, [["p1", "/wt/kd-KeepDeck-12"]]));
    expect(pathBelongsTo(set, "/wt/kd-KeepDeck-1")).toBe(false);
    expect(pathBelongsTo(set, "/wt/kd-KeepDeck-12")).toBe(true);
    expect(pathBelongsTo(set, "/wt/kd-KeepDeck-12/inner")).toBe(false);
    // A session with no recorded directory belongs nowhere.
    expect(pathBelongsTo(set, "")).toBe(false);
  });

  it("a team with nobody on it contributes nothing — no pane runs there", () => {
    // The set is where panes RUN. A team that kept its directory after its
    // last member closed holds a folder no process is in, and a scope
    // built on this set must not reach it.
    const set = workspaceDirectories(
      ws({
        cwd: "/repo",
        teams: [{ id: "team-empty", name: "empty", location: { kind: "attached", cwd: "/wt/empty" } }],
        panes: [],
      }),
    );
    expect([...set]).toEqual(["/repo"]);
  });

  it("a pane whose team has no resolved cwd contributes nothing yet", () => {
    // A team still creating its directory has no honest process location —
    // falling back to the workspace cwd would describe the wrong folder.
    const set = workspaceDirectories(
      ws({
        cwd: "/repo",
        teams: [
          {
            id: "team-1",
            name: "making",
            location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/a", index: 1 } },
          },
        ],
        panes: [{ id: "p1", team: { teamId: "team-1", role: "lead" } }],
      }),
    );
    expect([...set]).toEqual(["/repo"]);
  });
});

describe("skillRootsOf", () => {
  it("names every directory a CLI starts in, once each, and none for a create in flight", () => {
    // A pane on no team and a remote pane start in the workspace cwd; a
    // team's members in its worktree, once between them; a member of a
    // team mid-create nowhere yet. Through the one formula, so the four
    // answers cannot drift from the sweep's and the plan's.
    const roots = skillRootsOf(
      ws({
        teams: [
          { id: "team-a", name: "a", location: { kind: "attached", cwd: "/wt/a" } },
          {
            id: "team-b",
            name: "b",
            location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/b", index: 5 } },
          },
        ],
        panes: [
          { id: "bare" },
          { id: "remote", location: { kind: "remote", endpoint: "ws://vps" } },
          { id: "wt", team: { teamId: "team-a", role: "lead" } },
          { id: "wt-again", team: { teamId: "team-a", role: "impl-1" } },
          { id: "pending", team: { teamId: "team-b", role: "lead" } },
        ],
      }),
    );
    expect(roots).toEqual(["/repo", "/wt/a"]);
  });
});

describe("withHistoricalDirectories", () => {
  it("blank journal paths never land in the set", () => {
    const base = workspaceDirectories(ws({ cwd: "/repo" }));
    const grown = withHistoricalDirectories(base, ["", "/gone/wt"]);
    expect([...grown].sort()).toEqual(["/gone/wt", "/repo"]);
    // The input set is never mutated — builders stay composable.
    expect([...base]).toEqual(["/repo"]);
  });

  it("three builders, one predicate: each widening answers differently, the rule does not change", () => {
    // The substitutability pin: own-only, plus current panes, plus history
    // are three different SETS from three different builders, and the
    // predicate is the same function over each — no builder leaks its
    // method into the membership rule.
    const w = holding({ cwd: "/repo", worktreeBaseDir: "/wt" }, [["p1", "/wt/kd-a-1"]]);
    const own = new Set([w.cwd]);
    const withPanes = workspaceDirectories(w);
    const withHistory = withHistoricalDirectories(withPanes, ["/old/dir", ""]);

    expect(pathBelongsTo(own, "/wt/kd-a-1")).toBe(false);
    expect(pathBelongsTo(withPanes, "/wt/kd-a-1")).toBe(true);
    expect(pathBelongsTo(withPanes, "/old/dir")).toBe(false);
    expect(pathBelongsTo(withHistory, "/old/dir")).toBe(true);
    expect(pathBelongsTo(withHistory, "")).toBe(false);
    // Sizes strictly widen: three builders, three sets.
    expect(own.size).toBe(1);
    expect(withPanes.size).toBe(2);
    expect(withHistory.size).toBe(3);
  });
});
