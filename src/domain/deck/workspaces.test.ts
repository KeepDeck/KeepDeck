import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  addAgentPane,
  closeAgent,
  closeWorkspace,
  findWorkspace,
  findWorkspaceOfPane,
  firstFreeWorktree,
  gitWatchPaths,
  moveWorkspace,
  parentDir,
  paneExecutionCwd,
  renamePane,
  renameWorkspace,
  resolveActiveId,
  resolvePaneProvisioning,
  setPaneAutoTitle,
  paneOccupyingPath,
  pathOccupancy,
  setPaneProvisioningError,
  setPaneProvisioningPhase,
  setWorkspacePluginSlot,
  worktreeTargets,
  type Workspace,
} from "./workspaces";
import { type Pane } from "./panes";

const ws = (id: string, paneNums: number[]): Workspace => ({
  id,
  name: id,
  cwd: "/tmp",
  worktreeBaseDir: null,
  panes: paneNums.map((n) => ({ id: `${id}-p${n}` })),
});

describe("addAgentPane", () => {
  it("appends a provisioned pane (with worktree info) to the target only", () => {
    const pane = { id: "a-p2", cwd: "/wt/a-p2", branch: "kd/a/2" };
    const after = addAgentPane([ws("a", [1]), ws("b", [])], "a", pane);
    expect(after[0].panes).toEqual([{ id: "a-p1" }, pane]);
    expect(after[1].panes).toHaveLength(0); // b untouched
  });

  it("respects the pane cap", () => {
    const full = ws(
      "a",
      Array.from({ length: MAX_PANES }, (_, i) => i + 1),
    );
    const after = addAgentPane([full], "a", { id: "overflow" });
    expect(after[0].panes).toHaveLength(MAX_PANES);
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
  // A worktree-mode workspace: repo cwd + two worktree panes and one that fell
  // back to the cwd (no worktree of its own).
  const wtWs: Workspace = {
    id: "a",
    name: "a",
    cwd: "/repo",
    worktreeBaseDir: "/wt",
    panes: [
      { id: "a-p1", cwd: "/wt/kd-a-1", branch: "kd/a/1" },
      { id: "a-p2", cwd: "/wt/kd-a-2", branch: "kd/a/2" },
      { id: "a-p3" } as Pane, // create failed → runs in the cwd, nothing to delete
    ],
  };

  it("collects every worktree pane for a workspace close", () => {
    expect(worktreeTargets(wtWs)).toEqual([
      { repo: "/repo", path: "/wt/kd-a-1", branch: "kd/a/1" },
      { repo: "/repo", path: "/wt/kd-a-2", branch: "kd/a/2" },
    ]);
  });

  it("collects only the named pane for an agent close", () => {
    expect(worktreeTargets(wtWs, "a-p2")).toEqual([
      { repo: "/repo", path: "/wt/kd-a-2", branch: "kd/a/2" },
    ]);
  });

  it("returns nothing for a cwd-fallback pane (no worktree to delete)", () => {
    expect(worktreeTargets(wtWs, "a-p3")).toEqual([]);
  });

  it("collects a detached-HEAD worktree pane (cwd, no branch)", () => {
    const detached: Workspace = {
      id: "a",
      name: "a",
      cwd: "/repo",
      worktreeBaseDir: "/wt",
      panes: [{ id: "a-p1", cwd: "/wt/kd-a-1" }],
    };
    const targets = worktreeTargets(detached, "a-p1");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ repo: "/repo", path: "/wt/kd-a-1" });
    expect(targets[0].branch).toBeUndefined();
  });

  it("returns nothing for a non-worktree workspace", () => {
    const plain: Workspace = {
      id: "b",
      name: "b",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "b-p1" }, { id: "b-p2" }],
    };
    expect(worktreeTargets(plain)).toEqual([]);
    expect(worktreeTargets(plain, "b-p1")).toEqual([]);
  });

  it("uses runtime current branch for owned worktrees, without targeting detached heads", () => {
    const heads = new Map([
      ["/wt/kd-a-1", { branch: "feature/x" }],
      ["/wt/kd-a-2", { head: "a".repeat(40) }],
    ]);

    expect(worktreeTargets(wtWs, undefined, heads)).toEqual([
      { repo: "/repo", path: "/wt/kd-a-1", branch: "feature/x" },
    ]);
  });

  it("does not target cwd-fallback panes even when their repo branch is observed", () => {
    const plain: Workspace = {
      id: "b",
      name: "b",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "b-p1" }],
    };
    expect(
      worktreeTargets(plain, undefined, new Map([["/repo", { branch: "main" }]])),
    ).toEqual([]);
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

describe("paneExecutionCwd", () => {
  it("uses pane cwd when present, otherwise workspace cwd", () => {
    const workspace = ws("a", [1]);
    expect(paneExecutionCwd(workspace, { id: "a-p1", cwd: "/wt/one" })).toBe(
      "/wt/one",
    );
    expect(paneExecutionCwd(workspace, { id: "a-p1" })).toBe("/tmp");
  });

  it("returns null for unresolved provisioning panes", () => {
    const workspace = ws("a", []);
    expect(
      paneExecutionCwd(workspace, {
        id: "a-p1",
        provisioning: { repo: "/repo", baseDir: "/wt", workspace: "a", index: 1 },
      }),
    ).toBeNull();
  });
});

describe("gitWatchPaths", () => {
  it("collects distinct effective pane cwds across workspaces", () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        panes: [
          { id: "a-p1", cwd: "/wt/one", branch: "kd/a/1" },
          { id: "a-p2" }, // runs in the workspace folder
        ],
      },
      {
        ...ws("b", []),
        panes: [{ id: "b-p1", cwd: "/wt/two", branch: "kd/b/1" }],
      },
    ];
    expect(gitWatchPaths(deck)).toEqual(new Set(["/wt/one", "/tmp", "/wt/two"]));
  });

  it("skips unresolved provisioning panes", () => {
    expect(
      gitWatchPaths([
        {
          ...ws("a", []),
          panes: [
            {
              id: "a-p1",
              provisioning: {
                repo: "/repo",
                baseDir: "/wt",
                workspace: "a",
                index: 1,
              },
            },
          ],
        },
      ]),
    ).toEqual(new Set());
  });
});

describe("pane provisioning transforms", () => {
  const provisioningWs = (): Workspace => ({
    id: "a",
    name: "a",
    cwd: "/repo",
    worktreeBaseDir: "/wt",
    panes: [
      {
        id: "a-p1",
        provisioning: { repo: "/repo", baseDir: "/wt", workspace: "a", index: 1 },
      },
      { id: "a-p2", cwd: "/wt/live", branch: "kd/a/2" },
    ],
  });

  it("resolvePaneProvisioning pins the worktree and drops the card", () => {
    const next = resolvePaneProvisioning([provisioningWs()], "a", "a-p1", {
      cwd: "/wt/kd-a-1",
      branch: "kd/a/1",
    });
    expect(next[0].panes[0]).toEqual({
      id: "a-p1",
      cwd: "/wt/kd-a-1",
      branch: "kd/a/1",
    });
  });

  it("resolvePaneProvisioning no-ops (same ref) for a gone or live pane", () => {
    // Gone: the pane was closed mid-create; the late result must change nothing.
    const workspaces = [provisioningWs()];
    expect(
      resolvePaneProvisioning(workspaces, "a", "gone", { cwd: "/x", branch: "b" }),
    ).toBe(workspaces);
    expect(
      resolvePaneProvisioning(workspaces, "a", "a-p2", { cwd: "/x", branch: "b" }),
    ).toBe(workspaces);
  });

  it("setPaneProvisioningError records the failure and a retry clears it", () => {
    const failed = setPaneProvisioningError(
      [provisioningWs()],
      "a",
      "a-p1",
      "boom",
    );
    expect(failed[0].panes[0].provisioning?.error).toBe("boom");
    const retrying = setPaneProvisioningError(failed, "a", "a-p1", null);
    expect(retrying[0].panes[0].provisioning).toEqual({
      repo: "/repo",
      baseDir: "/wt",
      workspace: "a",
      index: 1,
    });
  });

  it("setPaneProvisioningError no-ops (same ref) on a non-provisioning pane and an unchanged error", () => {
    const workspaces = [provisioningWs()];
    expect(setPaneProvisioningError(workspaces, "a", "a-p2", "boom")).toBe(
      workspaces,
    );
    expect(setPaneProvisioningError(workspaces, "a", "a-p1", null)).toBe(
      workspaces,
    );
  });
});

describe("paneOccupyingPath", () => {
  const deck: Workspace[] = [
    {
      ...ws("a", []),
      panes: [
        { id: "a-p1", cwd: "/wt/one", branch: "kd/a/1" },
        { id: "a-p2" }, // workspace-cwd pane — occupies no worktree
      ],
    },
    {
      ...ws("b", []),
      panes: [{ id: "b-p1", dormant: true, cwd: "/wt/two", branch: "kd/b/2" }],
    },
  ];

  it("finds the pane running at the path, across workspaces", () => {
    const hit = paneOccupyingPath(deck, "/wt/one");
    expect(hit?.ws.id).toBe("a");
    expect(hit?.pane.id).toBe("a-p1");
    expect(hit?.index).toBe(0);
  });

  it("treats trailing slashes and whitespace as the same directory", () => {
    expect(paneOccupyingPath(deck, "  /wt/one/ ")?.pane.id).toBe("a-p1");
    const slashed: Workspace[] = [
      { ...ws("c", []), panes: [{ id: "c-p1", cwd: "/wt/three/" }] },
    ];
    expect(paneOccupyingPath(slashed, "/wt/three")?.pane.id).toBe("c-p1");
  });

  it("counts a dormant pane — it revives right back into its directory", () => {
    expect(paneOccupyingPath(deck, "/wt/two")?.pane.id).toBe("b-p1");
  });

  it("counts a provisioning intent — the create is in flight, cwd not yet set", () => {
    const provisioning: Workspace[] = [
      {
        ...ws("c", []),
        panes: [
          {
            id: "c-p1",
            provisioning: { repo: "/repo", path: "/wt/pending", workspace: "c", index: 1 },
          },
        ],
      },
    ];
    expect(paneOccupyingPath(provisioning, "/wt/pending/")?.pane.id).toBe("c-p1");
  });

  it("does not claim a path for a batch pane (its dir is backend-assigned)", () => {
    const batch: Workspace[] = [
      {
        ...ws("c", []),
        panes: [
          {
            id: "c-p1",
            // Batch flow: baseDir only, no explicit path yet — the exact dir is
            // assigned on the Rust side, so nothing here occupies it.
            provisioning: { repo: "/repo", baseDir: "/wt", workspace: "c", index: 1 },
          },
        ],
      },
    ];
    expect(paneOccupyingPath(batch, "/wt")).toBeNull();
    expect(paneOccupyingPath(batch, "/wt/kd-c-1")).toBeNull();
  });

  it("reports a free path (and an empty one) as unoccupied", () => {
    expect(paneOccupyingPath(deck, "/wt/free")).toBeNull();
    expect(paneOccupyingPath(deck, "   ")).toBeNull();
  });
});

describe("pathOccupancy", () => {
  it("a running pane's dir is worktree occupancy; a provisioning target isn't", () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        panes: [
          { id: "a-p1", cwd: "/wt/live", branch: "kd/a/1" },
          {
            id: "a-p2",
            provisioning: { repo: "/r", path: "/wt/pending", workspace: "a", index: 2 },
          },
        ],
      },
    ];
    expect(pathOccupancy(deck, "/wt/live")).toBe("worktree");
    expect(pathOccupancy(deck, "/wt/pending")).toBe("provisioning");
    expect(pathOccupancy(deck, "/wt/free")).toBeNull();
  });
});

describe("firstFreeWorktree", () => {
  /** Rust-style naming: index i → folder `kd-a-<i>`, branch `kd/a/<i>`. */
  const suggest = async (i: number) => ({
    branch: `kd/a/${i}`,
    folder: `kd-a-${i}`,
  });
  /** A deck whose panes hold `/base/kd-a-<n>` for each given n. */
  const holding = (...nums: number[]): Workspace[] => [
    {
      ...ws("a", []),
      panes: nums.map((n) => ({ id: `a-p${n}`, cwd: `/base/kd-a-${n}` })),
    },
  ];

  it("returns the start index untouched when it's free", async () => {
    expect(await firstFreeWorktree(holding(1), "/base", suggest, 2)).toEqual({
      path: "/base/kd-a-2",
      branch: "kd/a/2",
    });
  });

  it("skips occupied paths — folder and branch advance together", async () => {
    expect(await firstFreeWorktree(holding(2, 3), "/base", suggest, 2)).toEqual({
      path: "/base/kd-a-4",
      branch: "kd/a/4",
    });
  });

  it("skips a provisioning intent's target path too", async () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        panes: [
          {
            id: "a-p1",
            provisioning: { repo: "/r", path: "/base/kd-a-2", workspace: "a", index: 2 },
          },
        ],
      },
    ];
    expect((await firstFreeWorktree(deck, "/base", suggest, 2))?.path).toBe(
      "/base/kd-a-3",
    );
  });

  it("normalizes the base dir's trailing slash", async () => {
    expect((await firstFreeWorktree([], "/base///", suggest, 1))?.path).toBe(
      "/base/kd-a-1",
    );
  });

  it("gives up when suggestions dry up, or when every try is occupied", async () => {
    expect(await firstFreeWorktree([], "/base", async () => null, 1)).toBeNull();
    // A suggest stuck on one occupied name must hit the cap, not spin forever.
    const stuck = async () => ({ branch: "kd/a/2", folder: "kd-a-2" });
    expect(await firstFreeWorktree(holding(2), "/base", stuck, 2)).toBeNull();
  });

  it("skips a candidate the probe classifies as blocked (leftover dir with files)", async () => {
    const probe = async (path: string) => ({
      exists: path === "/base/kd-a-1",
      isWorktree: false,
      empty: false,
      branch: null,
    });
    expect(await firstFreeWorktree([], "/base", suggest, 1, probe)).toEqual({
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
    expect((await firstFreeWorktree([], "/base", suggest, 1, probe))?.path).toBe(
      "/base/kd-a-1",
    );
  });

  it("a null probe result (backend down) keeps the candidate", async () => {
    expect(
      (await firstFreeWorktree([], "/base", suggest, 1, async () => null))?.path,
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


describe("setPaneProvisioningPhase", () => {
  const provisioning = (extra = {}) => [
    {
      ...ws("a", []),
      panes: [
        { id: "p", provisioning: { repo: "/r", workspace: "a", index: 1, ...extra } },
      ],
    },
  ];

  it("marks the setup step on a live create", () => {
    const after = setPaneProvisioningPhase(provisioning(), "a", "p", "setup");
    expect(after[0].panes[0].provisioning?.phase).toBe("setup");
  });

  it("never marks a failed card, and re-marking is a no-op", () => {
    const failed = provisioning({ error: "boom" });
    expect(setPaneProvisioningPhase(failed, "a", "p", "setup")).toBe(failed);
    const marked = provisioning({ phase: "setup" });
    expect(setPaneProvisioningPhase(marked, "a", "p", "setup")).toBe(marked);
  });

  it("a failure clears the phase along with setting the error", () => {
    const after = setPaneProvisioningError(
      provisioning({ phase: "setup" }),
      "a",
      "p",
      "Setup failed: boom",
    );
    expect(after[0].panes[0].provisioning?.phase).toBeUndefined();
    expect(after[0].panes[0].provisioning?.error).toBe("Setup failed: boom");
  });
});
