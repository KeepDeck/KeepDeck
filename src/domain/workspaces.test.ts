import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  addAgentPane,
  closeAgent,
  closeWorkspace,
  moveWorkspace,
  renamePane,
  renameWorkspace,
  resolveActiveId,
  setPaneAutoTitle,
  setPaneHead,
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
