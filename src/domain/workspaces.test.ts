import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  addAgentPane,
  closeAgent,
  closeWorkspace,
  firstFreeWorktree,
  moveWorkspace,
  parentDir,
  renamePane,
  renameWorkspace,
  resolveActiveId,
  resolvePaneProvisioning,
  setPaneAutoTitle,
  paneOccupyingPath,
  pathOccupancy,
  setPaneHead,
  setPaneProvisioningError,
  setPaneProvisioningPhase,
  setWorkspaceRun,
  worktreeCwds,
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
});

describe("setPaneHead", () => {
  const deck = (): Workspace[] => [
    {
      ...ws("a", []),
      panes: [
        { id: "a-p1", cwd: "/wt/a-p1", branch: "kd/a/1" },
        { id: "a-p2", cwd: "/wt/a-p2", branch: "kd/a/2" },
      ],
    },
  ];

  it("moves the target pane to its new branch, leaving others alone", () => {
    const after = setPaneHead(deck(), "a", "a-p1", { branch: "feature/x" });
    expect(after[0].panes[0].branch).toBe("feature/x");
    expect(after[0].panes[1].branch).toBe("kd/a/2");
  });

  it("swaps branch for head on a detach, and back on a re-attach", () => {
    const sha = "a".repeat(40);
    const detached = setPaneHead(deck(), "a", "a-p1", { head: sha });
    expect(detached[0].panes[0].branch).toBeUndefined();
    expect(detached[0].panes[0].head).toBe(sha);

    const back = setPaneHead(detached, "a", "a-p1", { branch: "kd/a/1" });
    expect(back[0].panes[0].branch).toBe("kd/a/1");
    expect(back[0].panes[0].head).toBeUndefined();
  });

  it("returns the SAME array for a same-position event (no re-render)", () => {
    const before = deck();
    expect(setPaneHead(before, "a", "a-p1", { branch: "kd/a/1" })).toBe(before);
  });

  it("returns the SAME array when the pane is gone (event raced a close)", () => {
    const before = deck();
    expect(setPaneHead(before, "a", "gone", { branch: "x" })).toBe(before);
  });
});

describe("worktreeCwds", () => {
  it("collects distinct pane cwds across workspaces, skipping cwd-fallback panes", () => {
    const deck: Workspace[] = [
      {
        ...ws("a", []),
        panes: [
          { id: "a-p1", cwd: "/wt/one", branch: "kd/a/1" },
          { id: "a-p2" }, // runs in the workspace folder — nothing to watch
        ],
      },
      {
        ...ws("b", []),
        panes: [{ id: "b-p1", cwd: "/wt/two", branch: "kd/b/1" }],
      },
    ];
    expect(worktreeCwds(deck)).toEqual(new Set(["/wt/one", "/wt/two"]));
  });

  it("is empty for a deck with no worktree panes", () => {
    expect(worktreeCwds([ws("a", [1, 2])])).toEqual(new Set());
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

describe("setWorkspaceRun", () => {
  it("replaces only the target workspace's config", () => {
    const run = { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] };
    const after = setWorkspaceRun([ws("a", []), ws("b", [])], "a", run);
    expect(after[0].run).toEqual(run);
    expect(after[1].run).toBeUndefined();
  });

  it("drops the field entirely when the config empties (sparse persist)", () => {
    const seeded = setWorkspaceRun([ws("a", [])], "a", {
      presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
    });
    const cleared = setWorkspaceRun(seeded, "a", { presets: [] });
    expect("run" in cleared[0]).toBe(false);
  });

  it("keeps the field while a setup command remains", () => {
    const after = setWorkspaceRun([ws("a", [])], "a", {
      presets: [],
      setup: "pnpm i",
    });
    expect(after[0].run).toEqual({ presets: [], setup: "pnpm i" });
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
