import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  addAgentPane,
  autoWorkspaceName,
  closeAgent,
  closeWorkspace,
  findWorkspace,
  findWorkspaceOfPane,
  firstFreeTeamWorktree,
  moveWorkspace,
  parentDir,
  renameWorkspace,
  resolveActiveId,
  directoryState,
  setWorkspacePluginSlot,
  worktreeTargets,
  type Workspace,
} from "./workspaces";
import { gitWatchPaths, paneExecutionCwd } from "./roots";
import {
  clearPaneIdle,
  failPaneWake,
  parkPane,
  renamePane,
  requestPaneWake,
  setPaneAutoTitle,
  suspendPane,
  type Pane,
} from "./panes";
import type { Team } from "./teams";
import { createWorkspaceInstance } from "../workspaceInstance";

const ws = (id: string, paneNums: number[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/tmp",
  worktreeBaseDir: null,
  panes: paneNums.map((n) => ({ id: `${id}-p${n}` })),
});

describe("addAgentPane", () => {
  it("appends a pane (with its membership) to the target only", () => {
    const pane: Pane = { id: "a-p2", team: { teamId: "team-1", role: "lead" } };
    const after = addAgentPane([ws("a", [1]), ws("b", [])], "a", pane);
    expect(after[0].panes).toEqual([{ id: "a-p1" }, pane]);
    expect(after[1].panes).toHaveLength(0); // b untouched
  });

  it("appends past sixteen — the cap is the team's, not the workspace's", () => {
    // A workspace holds as many teams as it is given; `joinTeam` is what
    // refuses a seventeenth member of ONE team.
    const full = ws(
      "a",
      Array.from({ length: MAX_PANES }, (_, i) => i + 1),
    );
    const after = addAgentPane([full], "a", { id: "overflow" });
    expect(after[0].panes).toHaveLength(MAX_PANES + 1);
  });
});

describe("closeAgent", () => {
  it("removes a pane only from the target workspace", () => {
    const after = closeAgent([ws("a", [1, 2]), ws("b", [1])], "a", "a-p1");
    expect(after[0].panes.map((p) => p.id)).toEqual(["a-p2"]);
    expect(after[1].panes).toHaveLength(1); // b untouched
  });
});

describe("closeWorkspace", () => {
  it("removes the workspace by id", () => {
    const after = closeWorkspace([ws("a", [1]), ws("b", [2])], "a");
    expect(after.map((w) => w.id)).toEqual(["b"]);
  });

  it("can remove the last workspace, leaving none", () => {
    expect(closeWorkspace([ws("a", [1])], "a")).toEqual([]);
  });
});

describe("renameWorkspace", () => {
  it("autoWorkspaceName: one derivation for birth and reset, id fallback outside the scheme", () => {
    expect(autoWorkspaceName("ws-3")).toBe("workspace-3");
    // A hand-edited or migrated deck can hold an id outside `ws-N` — the id
    // itself is the least-wrong name that still identifies the row.
    expect(autoWorkspaceName("imported-deck")).toBe("imported-deck");
  });

  it("an empty name reverts to the auto name from the workspace's slot", () => {
    // The reset-on-empty contract renamePane already has — a workspace has no
    // render-time fallback, so the revert happens in the domain op itself.
    const after = renameWorkspace([ws("ws-3", [1])], "ws-3", "   ");
    expect(after[0].name).toBe("workspace-3");
  });

  it("renames the target workspace only", () => {
    const after = renameWorkspace([ws("a", [1]), ws("b", [2])], "a", "my-api");
    expect(after[0].name).toBe("my-api");
    expect(after[0].panes).toHaveLength(1); // panes untouched
    expect(after[1].name).toBe("b");
  });
});

describe("moveWorkspace", () => {
  const ids = (list: Workspace[]) => list.map((w) => w.id);
  const three = [ws("a", []), ws("b", []), ws("c", [])];

  it("moves an item down to a later index", () => {
    expect(ids(moveWorkspace(three, "a", 2))).toEqual(["b", "c", "a"]);
  });

  it("moves an item up to an earlier index", () => {
    expect(ids(moveWorkspace(three, "c", 0))).toEqual(["c", "a", "b"]);
  });

  it("clamps an out-of-range target to the ends", () => {
    expect(ids(moveWorkspace(three, "a", 99))).toEqual(["b", "c", "a"]);
    expect(ids(moveWorkspace(three, "c", -5))).toEqual(["c", "a", "b"]);
  });

  it("returns the SAME array reference on a no-op move (no re-render)", () => {
    expect(moveWorkspace(three, "b", 1)).toBe(three); // already at index 1
    expect(moveWorkspace(three, "missing", 0)).toBe(three); // unknown id
  });
});

describe("resolveActiveId", () => {
  it("keeps the active id when it still exists", () => {
    expect(resolveActiveId([ws("a", []), ws("b", [])], "b")).toBe("b");
  });

  it("falls back to the first workspace when the active one is gone", () => {
    expect(resolveActiveId([ws("a", []), ws("b", [])], "gone")).toBe("a");
  });

  it("returns an empty id when no workspaces remain", () => {
    expect(resolveActiveId([], "a")).toBe("");
  });
});

describe("renamePane", () => {
  it("sets a pane's name in the target workspace only", () => {
    const after = renamePane(
      [ws("a", [1, 2]), ws("b", [1])],
      "a",
      "a-p2",
      "Build",
    );
    expect(after[0].panes).toEqual([
      { id: "a-p1" },
      { id: "a-p2", name: "Build" },
    ]);
    expect(after[1].panes).toEqual([{ id: "b-p1" }]); // b untouched
  });

  it("clears the name (reverts to auto) on an empty/whitespace name", () => {
    const named = renamePane([ws("a", [1])], "a", "a-p1", "X");
    expect(named[0].panes[0]).toEqual({ id: "a-p1", name: "X" });
    expect(renamePane(named, "a", "a-p1", "   ")[0].panes[0]).toEqual({
      id: "a-p1",
    });
  });
});

describe("worktreeTargets", () => {
  // A worktree-mode workspace: two teams on worktrees of their own, one on
  // the repo root, and one whose create is still out. Members are beside
  // the point — the directory is the team's.
  const wtWs: Workspace = {
    id: "a",
    instance: createWorkspaceInstance(),
    name: "a",
    cwd: "/repo",
    worktreeBaseDir: "/wt",
    panes: [
      { id: "a-p1", team: { teamId: "team-1", role: "lead" } },
      { id: "a-p2", team: { teamId: "team-2", role: "lead" } },
      { id: "a-p3", team: { teamId: "team-3", role: "lead" } },
      { id: "a-p4", team: { teamId: "team-4", role: "lead" } },
    ],
    teams: [
      { id: "team-1", name: "one", location: { kind: "attached", cwd: "/wt/kd-a-1", branch: "kd/a/1" } },
      { id: "team-2", name: "two", location: { kind: "attached", cwd: "/wt/kd-a-2", branch: "kd/a/2" } },
      { id: "team-3", name: "root", location: { kind: "attached", cwd: "/repo", branch: "main" } },
      {
        id: "team-4",
        name: "making",
        location: {
          kind: "provisioning",
          intent: { repo: "/repo", path: "/wt/kd-a-4", index: 4 },
        },
      },
    ],
  };

  it("collects every team's worktree for a workspace close", () => {
    expect(worktreeTargets(wtWs)).toEqual([
      { repo: "/repo", path: "/wt/kd-a-1", branch: "kd/a/1" },
      { repo: "/repo", path: "/wt/kd-a-2", branch: "kd/a/2" },
    ]);
  });

  it("collects only the named team for a disband", () => {
    expect(worktreeTargets(wtWs, "team-2")).toEqual([
      { repo: "/repo", path: "/wt/kd-a-2", branch: "kd/a/2" },
    ]);
  });

  it("never targets the workspace root — a team there disbands without deleting", () => {
    expect(worktreeTargets(wtWs, "team-3")).toEqual([]);
    // However the root is spelled: the same directory is the same directory.
    const trailing: Workspace = { ...wtWs, cwd: "/repo/" };
    expect(worktreeTargets(trailing, "team-3")).toEqual([]);
    expect(
      worktreeTargets(wtWs, "team-3", new Map([["/repo", { branch: "main" }]])),
    ).toEqual([]);
  });

  it("has nothing to name for a team whose create is still out", () => {
    // The close flow covers that worktree by the create's ticket, not by
    // a directory the team does not hold yet.
    expect(worktreeTargets(wtWs, "team-4")).toEqual([]);
  });

  it("collects a detached-HEAD worktree (cwd, no branch)", () => {
    const detached: Workspace = {
      ...wtWs,
      teams: [{ id: "team-1", name: "one", location: { kind: "attached", cwd: "/wt/kd-a-1" } }],
    };
    const targets = worktreeTargets(detached, "team-1");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ repo: "/repo", path: "/wt/kd-a-1" });
    expect(targets[0].branch).toBeUndefined();
  });

  it("returns nothing for a non-worktree workspace — every team runs in the root", () => {
    const plain: Workspace = {
      id: "b",
      instance: createWorkspaceInstance(),
      name: "b",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "b-p1", team: { teamId: "team-1", role: "lead" } }],
      teams: [{ id: "team-1", name: "root", location: { kind: "attached", cwd: "/repo" } }],
    };
    expect(worktreeTargets(plain)).toEqual([]);
    expect(worktreeTargets(plain, "team-1")).toEqual([]);
    expect(
      worktreeTargets(plain, undefined, new Map([["/repo", { branch: "main" }]])),
    ).toEqual([]);
  });

  it("uses runtime current branch for owned worktrees; a detached head offers the dir alone", () => {
    const heads = new Map([
      ["/wt/kd-a-1", { branch: "feature/x" }],
      ["/wt/kd-a-2", { head: "a".repeat(40) }],
    ]);

    // The detached team's target carries NO branch — not even the team's
    // durable one, which the observed bare commit has superseded. Deleting a
    // branch would be ambiguous there; skipping the whole target (as this
    // once did) stranded the directory with the delete checkbox gone, against
    // the WorktreeTarget contract.
    expect(worktreeTargets(wtWs, undefined, heads)).toEqual([
      { repo: "/repo", path: "/wt/kd-a-1", branch: "feature/x" },
      { repo: "/repo", path: "/wt/kd-a-2", branch: undefined },
    ]);
  });
});

describe("findWorkspace / findWorkspaceOfPane", () => {
  const deck = [ws("a", [1, 2]), ws("b", [1])];

  it("findWorkspace returns the workspace by id, or undefined", () => {
    expect(findWorkspace(deck, "b")).toBe(deck[1]);
    expect(findWorkspace(deck, "nope")).toBeUndefined();
  });

  it("findWorkspaceOfPane returns the workspace owning the pane, or undefined", () => {
    expect(findWorkspaceOfPane(deck, "b-p1")).toBe(deck[1]);
    expect(findWorkspaceOfPane(deck, "a-p2")).toBe(deck[0]);
    expect(findWorkspaceOfPane(deck, "ghost")).toBeUndefined();
  });
});

describe("setPaneAutoTitle", () => {
  it("sets the (trimmed) auto title in the target pane only", () => {
    const after = setPaneAutoTitle([ws("a", [1, 2])], "a", "a-p1", "  ~/proj  ");
    expect(after[0].panes[0]).toEqual({ id: "a-p1", autoTitle: "~/proj" });
    expect(after[0].panes[1]).toEqual({ id: "a-p2" });
  });

  it("clears the auto title when empty", () => {
    const set = setPaneAutoTitle([ws("a", [1])], "a", "a-p1", "t");
    expect(setPaneAutoTitle(set, "a", "a-p1", "")[0].panes[0]).toEqual({
      id: "a-p1",
    });
  });

  it("returns the SAME array when the (trimmed) title is unchanged", () => {
    const set = setPaneAutoTitle([ws("a", [1])], "a", "a-p1", "t");
    expect(setPaneAutoTitle(set, "a", "a-p1", "  t  ")).toBe(set);
  });

  it("returns the SAME array for an absent pane", () => {
    const base = [ws("a", [1])];
    expect(setPaneAutoTitle(base, "a", "a-p9", "x")).toBe(base);
  });
});

/** A team attached to `cwd`, and one member on it. */
const teamAt = (id: string, cwd: string, branch?: string): Team => ({
  id,
  name: id,
  location: branch !== undefined ? { kind: "attached", cwd, branch } : { kind: "attached", cwd },
});
const creatingTeam = (id: string, path: string): Team => ({
  id,
  name: id,
  location: { kind: "provisioning", intent: { repo: "/repo", path, index: 1 } },
});
const memberOf = (id: string, teamId: string): Pane => ({ id, team: { teamId, role: "lead" } });

describe("paneExecutionCwd", () => {
  it("uses the team's directory when the pane is on one, otherwise the workspace cwd", () => {
    const workspace: Workspace = { ...ws("a", [1]), teams: [teamAt("team-1", "/wt/one")] };
    expect(paneExecutionCwd(workspace, memberOf("a-p1", "team-1"))).toBe("/wt/one");
    expect(paneExecutionCwd(workspace, { id: "a-p1" })).toBe("/tmp");
  });

  it("returns null while the team's create is still out", () => {
    const workspace: Workspace = { ...ws("a", []), teams: [creatingTeam("team-1", "/wt/a-1")] };
    expect(paneExecutionCwd(workspace, memberOf("a-p1", "team-1"))).toBeNull();
  });
});

describe("gitWatchPaths", () => {
  it("collects distinct effective pane cwds across workspaces", () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        teams: [teamAt("team-1", "/wt/one", "kd/a/1")],
        panes: [
          memberOf("a-p1", "team-1"),
          { id: "a-p2" }, // runs in the workspace folder
        ],
      },
      {
        ...ws("b", []),
        teams: [teamAt("team-2", "/wt/two", "kd/b/1")],
        panes: [memberOf("b-p1", "team-2")],
      },
    ];
    expect(gitWatchPaths(deck)).toEqual(new Set(["/wt/one", "/tmp", "/wt/two"]));
  });

  it("skips a team whose create is still out", () => {
    expect(
      gitWatchPaths([
        {
          ...ws("a", []),
          teams: [creatingTeam("team-1", "/wt/a-1")],
          panes: [memberOf("a-p1", "team-1")],
        },
      ]),
    ).toEqual(new Set());
  });
});

describe("directoryState", () => {
  it("says what a location field needs: worked in, being created, or free", () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        teams: [teamAt("team-1", "/wt/live", "kd/a/1"), creatingTeam("team-2", "/wt/pending")],
        panes: [memberOf("a-p1", "team-1"), memberOf("a-p2", "team-2"), { id: "a-p3" }],
      },
    ];
    const here = deck[0];
    // A team WORKS there — not a refusal: the field offers the attach, and
    // the create asks the person whose directory it is.
    expect(directoryState(deck, here, "/wt/live")).toBe("worked-in");
    expect(directoryState(deck, here, "  /wt/live/ ")).toBe("worked-in");
    // A create is heading there: nothing to attach to, and no second one.
    expect(directoryState(deck, here, "/wt/pending")).toBe("being-created");
    expect(directoryState(deck, here, "/wt/free")).toBe("free");
    expect(directoryState(deck, here, "   ")).toBe("free");
  });

  it("a create that FAILED is not one still running", () => {
    // Its card waits for Retry; telling the person to "try again in a
    // moment" would be a wait that never ends.
    const failed = creatingTeam("team-2", "/wt/pending");
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        teams: [{ ...failed, location: { ...failed.location!, error: "boom" } as never }],
        panes: [],
      },
    ];
    expect(directoryState(deck, deck[0], "/wt/pending")).toBe("worked-in");
  });
});

describe("firstFreeTeamWorktree", () => {
  /** Rust-style naming: index i → folder `kd-a-<i>`, branch `kd/a/<i>`. */
  const suggest = async (i: number) => ({
    branch: `kd/a/${i}`,
    folder: `kd-a-${i}`,
  });
  /** A deck whose teams hold `/base/kd-a-<n>` for each given n. */
  const holding = (...nums: number[]): Workspace[] => [
    {
      ...ws("a", []),
      teams: nums.map((n) => teamAt(`team-${n}`, `/base/kd-a-${n}`)),
      panes: nums.map((n) => memberOf(`a-p${n}`, `team-${n}`)),
    },
  ];

  it("returns the start index untouched when it's free", async () => {
    expect(await firstFreeTeamWorktree(holding(1), "/base", suggest, 2)).toEqual({
      path: "/base/kd-a-2",
      branch: "kd/a/2",
    });
  });

  it("skips occupied paths — folder and branch advance together", async () => {
    expect(await firstFreeTeamWorktree(holding(2, 3), "/base", suggest, 2)).toEqual({
      path: "/base/kd-a-4",
      branch: "kd/a/4",
    });
  });

  it("skips a provisioning intent's target path too", async () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        teams: [creatingTeam("team-1", "/base/kd-a-2")],
        panes: [memberOf("a-p1", "team-1")],
      },
    ];
    expect((await firstFreeTeamWorktree(deck, "/base", suggest, 2))?.path).toBe(
      "/base/kd-a-3",
    );
  });

  it("normalizes the base dir's trailing slash", async () => {
    expect((await firstFreeTeamWorktree([], "/base///", suggest, 1))?.path).toBe(
      "/base/kd-a-1",
    );
  });

  it("gives up when suggestions dry up, or when every try is occupied", async () => {
    expect(await firstFreeTeamWorktree([], "/base", async () => null, 1)).toBeNull();
    // A suggest stuck on one occupied name must hit the cap, not spin forever.
    const stuck = async () => ({ branch: "kd/a/2", folder: "kd-a-2" });
    expect(await firstFreeTeamWorktree(holding(2), "/base", stuck, 2)).toBeNull();
  });

  it("skips a candidate the probe classifies as blocked (leftover dir with files)", async () => {
    const probe = async (path: string) => ({
      exists: path === "/base/kd-a-1",
      isWorktree: false,
      empty: false,
      branch: null,
    });
    expect(await firstFreeTeamWorktree([], "/base", suggest, 1, probe)).toEqual({
      path: "/base/kd-a-2",
      branch: "kd/a/2",
    });
  });

  it("keeps a candidate that probes as an idle worktree — attaching is a valid outcome", async () => {
    const probe = async () => ({
      exists: true,
      isWorktree: true,
      empty: false,
      branch: "kd/a/1",
    });
    expect((await firstFreeTeamWorktree([], "/base", suggest, 1, probe))?.path).toBe(
      "/base/kd-a-1",
    );
  });

  it("a null probe result (backend down) keeps the candidate", async () => {
    expect(
      (await firstFreeTeamWorktree([], "/base", suggest, 1, async () => null))?.path,
    ).toBe("/base/kd-a-1");
  });
});

describe("parentDir", () => {
  it("returns the containing directory", () => {
    expect(parentDir("/base/kd-a-2")).toBe("/base");
    expect(parentDir("/a/b/c/")).toBe("/a/b");
  });

  it("has no usable parent for bare names and root children", () => {
    expect(parentDir("kd-a-2")).toBe("");
    expect(parentDir("/kd-a-2")).toBe("");
    expect(parentDir("/")).toBe("");
  });
});

describe("setWorkspacePluginSlot", () => {
  it("creates a new slot in the target workspace only", () => {
    const before = [ws("a", []), ws("b", [])];
    const after = setWorkspacePluginSlot(before, "a", "git", { remote: "origin" });
    expect(after[0].plugins).toEqual({ git: { remote: "origin" } });
    expect(after[1]).toBe(before[1]); // b untouched — same reference
  });

  it("replaces an existing slot's value", () => {
    const seeded = setWorkspacePluginSlot([ws("a", [])], "a", "git", { v: 1 });
    const replaced = setWorkspacePluginSlot(seeded, "a", "git", { v: 2 });
    expect(replaced[0].plugins).toEqual({ git: { v: 2 } });
  });

  it("two plugins' slots coexist independently in one workspace", () => {
    const withGit = setWorkspacePluginSlot([ws("a", [])], "a", "git", { v: 1 });
    const withBoth = setWorkspacePluginSlot(withGit, "a", "notes", { text: "hi" });
    expect(withBoth[0].plugins).toEqual({
      git: { v: 1 },
      notes: { text: "hi" },
    });
    // Changing one slot leaves the other exactly as it was.
    const changed = setWorkspacePluginSlot(withBoth, "a", "git", { v: 2 });
    expect(changed[0].plugins).toEqual({ git: { v: 2 }, notes: { text: "hi" } });
  });

  it("deletes a slot via undefined, dropping the whole bag when it was the last one", () => {
    const seeded = setWorkspacePluginSlot([ws("a", [])], "a", "git", { v: 1 });
    const cleared = setWorkspacePluginSlot(seeded, "a", "git", undefined);
    expect("plugins" in cleared[0]).toBe(false);
  });

  it("deleting one of several slots keeps the bag with the rest", () => {
    const withGit = setWorkspacePluginSlot([ws("a", [])], "a", "git", { v: 1 });
    const withBoth = setWorkspacePluginSlot(withGit, "a", "notes", { text: "hi" });
    const after = setWorkspacePluginSlot(withBoth, "a", "git", undefined);
    expect(after[0].plugins).toEqual({ notes: { text: "hi" } });
  });

  it("returns the SAME array on a genuine no-op", () => {
    // Deleting an already-absent slot.
    const empty = [ws("a", [])];
    expect(setWorkspacePluginSlot(empty, "a", "git", undefined)).toBe(empty);

    // Re-setting a slot to the value it already holds (same reference).
    const value = { v: 1 };
    const seeded = setWorkspacePluginSlot([ws("a", [])], "a", "git", value);
    expect(setWorkspacePluginSlot(seeded, "a", "git", value)).toBe(seeded);

    // Unknown workspace id.
    expect(setWorkspacePluginSlot(empty, "gone", "git", { v: 1 })).toBe(empty);
  });
});


describe("suspendPane", () => {
  const AT = "2026-07-25T10:00:00.000Z";
  const withPanes = (panes: Pane[]): Workspace[] => [
    { ...ws("a", []), panes },
    ws("b", [1]),
  ];

  it("marks the pane suspended, stamped, and leaves everything else alone", () => {
    const start = withPanes([
      {
        id: "a-p1",
        team: { teamId: "team-1", role: "lead" },
        session: { id: "s1", boundAt: "2026-07-25T09:00:00.000Z" },
      },
      { id: "a-p2" },
    ]);
    const after = suspendPane(start, "a", "a-p1", AT);
    // The membership (the pane's directory is its team's) and the resume key
    // are exactly what a resume needs later — suspending must not touch either.
    expect(after[0].panes[0]).toEqual({
      id: "a-p1",
      team: { teamId: "team-1", role: "lead" },
      session: { id: "s1", boundAt: "2026-07-25T09:00:00.000Z" },
      idle: { reason: "suspended", at: AT },
    });
    expect(after[0].panes[1]).toEqual({ id: "a-p2" });
    expect(after[1]).toBe(start[1]); // the other workspace keeps its identity
  });

  it("is a no-op (same ref) for an unknown pane or workspace", () => {
    const start = withPanes([{ id: "a-p1" }]);
    expect(suspendPane(start, "a", "nope", AT)).toBe(start);
    expect(suspendPane(start, "nope", "a-p1", AT)).toBe(start);
  });

  it("is a no-op for a pane that is already STAYING down", () => {
    const suspended = withPanes([
      { id: "a-p1", idle: { reason: "suspended", at: AT } },
    ]);
    expect(suspendPane(suspended, "a", "a-p1", "2026-07-25T11:00:00.000Z")).toBe(
      suspended,
    );
    const parked = withPanes([{ id: "a-p1", idle: { reason: "parked" } }]);
    expect(suspendPane(parked, "a", "a-p1", AT)).toBe(parked);
  });

  it("CANCELS a wake in progress — a rising pane is still stoppable", () => {
    // Panes in a workspace the user isn't looking at stay `waking` until it is
    // activated, so refusing every idle pane made those agents unparkable.
    const rising = withPanes([
      { id: "a-p1", idle: { reason: "waking", origin: "restore" } },
    ]);
    expect(suspendPane(rising, "a", "a-p1", AT)[0].panes[0].idle).toEqual({
      reason: "suspended",
      at: AT,
    });
  });

  it("refuses a pane whose team is still creating its directory — there is no process, and the create must not be stranded", () => {
    const creating: Workspace[] = [
      {
        ...ws("a", []),
        teams: [creatingTeam("team-1", "/wt/a-1")],
        panes: [memberOf("a-p1", "team-1")],
      },
      ws("b", [1]),
    ];
    expect(suspendPane(creating, "a", "a-p1", AT)).toBe(creating);
  });

  it("round-trips: suspend → ask → finish leaves a plain live pane", () => {
    const start = withPanes([memberOf("a-p1", "team-1")]);
    const suspended = suspendPane(start, "a", "a-p1", AT);
    const rising = requestPaneWake(suspended, "a", "a-p1");
    const woken = clearPaneIdle(rising, "a", "a-p1");
    expect(woken[0].panes[0]).toEqual(memberOf("a-p1", "team-1"));
  });

  it("a suspend landing mid-wake wins: the late finish finds nothing to do", () => {
    // The sweep can be out on a probe when the user stops the pane; clearing
    // then would spawn the process they just stopped.
    const rising = withPanes([
      { id: "a-p1", idle: { reason: "waking", origin: "manual" } },
    ]);
    const stopped = suspendPane(rising, "a", "a-p1", AT);
    expect(clearPaneIdle(stopped, "a", "a-p1")).toBe(stopped);
  });

  it("refuses a REMOTE pane — the guard is the predicate, not a copy of it", () => {
    // The action is exported through the deck barrel, so a future "suspend
    // every agent here" must not park the panes the predicate protects.
    const remote = withPanes([
      { id: "a-p1", location: { kind: "remote", endpoint: "ws://vps:4500" } },
    ]);
    expect(suspendPane(remote, "a", "a-p1", AT)).toBe(remote);
  });
});

describe("requestPaneWake", () => {
  const AT = "2026-07-25T10:00:00.000Z";
  const withPane = (pane: Pane): Workspace[] => [{ ...ws("a", []), panes: [pane] }];

  it("hands a suspended pane back to the sweep, marked as the user's doing", () => {
    const after = requestPaneWake(
      withPane({ id: "a-p1", idle: { reason: "suspended", at: AT } }),
      "a",
      "a-p1",
    );
    // Still idle — the sweep owns the probe, the resume plan and the wake.
    // `manual`, not `restore`: the origin decides what a rejected session id
    // is allowed to do afterwards. The marker it rose FROM rides along whole,
    // so a wake that fails can put the pane back exactly where it was — a
    // stamp alone would have to be decoded back into a reason, and a decode
    // is a guess that gets worse every time the union grows.
    expect(after[0].panes[0].idle).toEqual({
      reason: "waking",
      origin: "manual",
      from: { reason: "suspended", at: AT },
    });
  });

  it("does the same for a pane parked by the launch policy", () => {
    const after = requestPaneWake(
      withPane({ id: "a-p1", idle: { reason: "parked" } }),
      "a",
      "a-p1",
    );
    // `parked` is carried too: it is where this pane goes back to, and the
    // difference from "carried nothing" is what keeps a failed wake from
    // inventing a suspend the user never asked for.
    expect(after[0].panes[0].idle).toEqual({
      reason: "waking",
      origin: "manual",
      from: { reason: "parked" },
    });
  });

  it("UPGRADES a pane the sweep was already raising on its own", () => {
    // "A human asked" is new information even mid-wake, and it is the only
    // thing standing between a rejected session id and a silent new
    // conversation — so a boot-restore wake is re-marked, not left alone.
    // This is what makes the blocked card's "Look again" mean anything.
    const restored = withPane({
      id: "a-p1",
      idle: { reason: "waking", origin: "restore" },
    });
    expect(requestPaneWake(restored, "a", "a-p1")[0].panes[0].idle).toEqual({
      reason: "waking",
      origin: "manual",
    });
  });

  it("is a no-op (same ref) for a live pane, one already asked for, or an unknown id", () => {
    const live = withPane({ id: "a-p1" });
    expect(requestPaneWake(live, "a", "a-p1")).toBe(live);
    // A second click while the sweep is still working must not re-mark it.
    const asked = withPane({ id: "a-p1", idle: { reason: "waking", origin: "manual" } });
    expect(requestPaneWake(asked, "a", "a-p1")).toBe(asked);
    expect(requestPaneWake(asked, "a", "nope")).toBe(asked);
    expect(requestPaneWake(asked, "nope", "a-p1")).toBe(asked);
  });
});

describe("parkPane", () => {
  const AT = "2026-07-25T09:00:00.000Z";
  const withPane = (pane: Pane): Workspace[] => [{ ...ws("a", []), panes: [pane] }];

  it("stops a rising pane so its card says stopped instead of starting", () => {
    const before = withPane({
      id: "pane-1",
      idle: { reason: "waking", origin: "restore" },
    });
    expect(parkPane(before, "a", "pane-1")[0].panes[0].idle).toEqual({
      reason: "parked",
    });
  });

  it("does not touch a wake the user asked for by name", () => {
    // The policy governs what starts on its own, not what someone just asked
    // for — taking that request away would be answering a different question.
    const before = withPane({
      id: "pane-1",
      idle: { reason: "waking", origin: "manual" },
    });
    expect(parkPane(before, "a", "pane-1")).toBe(before);
  });

  it("does not touch a RUNNING pane — a preference must not kill a live agent", () => {
    const before = withPane({ id: "pane-1" });
    expect(parkPane(before, "a", "pane-1")).toBe(before);
  });

  it("leaves a suspend stamp alone rather than overwriting it", () => {
    const before = withPane({
      id: "pane-1",
      idle: { reason: "suspended", at: AT },
    });
    expect(parkPane(before, "a", "pane-1")).toBe(before);
  });

  it("returns the same array for an unknown pane", () => {
    const before = withPane({ id: "pane-1" });
    expect(parkPane(before, "a", "pane-9")).toBe(before);
  });
});

describe("failPaneWake", () => {
  const AT = "2026-07-25T09:00:00.000Z";
  const withPane = (pane: Pane): Workspace[] => [{ ...ws("a", []), panes: [pane] }];

  it("puts a manual wake back down with the stamp it went up with", () => {
    const suspended = withPane({ id: "a-p1", idle: { reason: "suspended", at: AT } });
    const waking = requestPaneWake(suspended, "a", "a-p1");
    const back = failPaneWake(waking, "a", "a-p1");
    // The card reads exactly as it did before the failed attempt — restamping
    // it "just now" would misdate a suspend the user made hours ago.
    expect(back[0].panes[0].idle).toEqual({ reason: "suspended", at: AT });
  });

  it("returns a merely-PARKED pane to parked, never to a durable suspend", () => {
    // `parked` is runtime-only on purpose: writing `suspended` here would
    // forge a decision the user never made and make it survive restarts, so
    // turning the launch policy off could never bring this pane back.
    const waking = requestPaneWake(
      withPane({ id: "a-p1", idle: { reason: "parked" } }),
      "a",
      "a-p1",
    );
    expect(failPaneWake(waking, "a", "a-p1")[0].panes[0].idle).toEqual({
      reason: "parked",
    });
  });

  it("returns a pane the user asked for at BOOT to parked as well", () => {
    // Restored → "Look again" upgrades it to a manual wake with no stamp;
    // a failure leaves it stopped and waiting, not falsely suspended.
    const upgraded = requestPaneWake(
      withPane({ id: "a-p1", idle: { reason: "waking", origin: "restore" } }),
      "a",
      "a-p1",
    );
    expect(failPaneWake(upgraded, "a", "a-p1")[0].panes[0].idle).toEqual({
      reason: "parked",
    });
  });

  it("lands on the LATEST suspend when the user stops a pane mid-wake", () => {
    // Reachable in three gestures: resume a suspended pane, stop it again
    // while the sweep is still probing, resume once more. The second suspend
    // is the one the pane must return to — restoring the first would date the
    // card by a decision the user has already replaced.
    const LATER = "2026-07-25T11:30:00.000Z";
    const suspended = withPane({ id: "a-p1", idle: { reason: "suspended", at: AT } });
    const rising = requestPaneWake(suspended, "a", "a-p1");
    const stoppedAgain = suspendPane(rising, "a", "a-p1", LATER);
    const risingAgain = requestPaneWake(stoppedAgain, "a", "a-p1");

    expect(failPaneWake(risingAgain, "a", "a-p1")[0].panes[0].idle).toEqual({
      reason: "suspended",
      at: LATER,
    });
  });

  it("leaves a BOOT restore alone — its fresh-start degradation is deliberate", () => {
    const booting = withPane({
      id: "a-p1",
      idle: { reason: "waking", origin: "restore" },
    });
    expect(failPaneWake(booting, "a", "a-p1")).toBe(booting);
  });

  it("is a no-op (same ref) for a live pane or an unknown id", () => {
    const live = withPane({ id: "a-p1" });
    expect(failPaneWake(live, "a", "a-p1")).toBe(live);
    expect(failPaneWake(live, "a", "nope")).toBe(live);
    const suspended = withPane({ id: "a-p1", idle: { reason: "suspended", at: AT } });
    expect(failPaneWake(suspended, "a", "a-p1")).toBe(suspended);
  });
});
