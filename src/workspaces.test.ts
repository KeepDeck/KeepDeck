import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  addAgent,
  addAgentPane,
  closeAgent,
  closeWorkspace,
  renameWorkspace,
  resolveActiveId,
  type Workspace,
} from "./workspaces";

const ws = (id: string, paneNums: number[]): Workspace => ({
  id,
  name: id,
  cwd: "/tmp",
  agentType: "claude",
  worktreeBaseDir: null,
  panes: paneNums.map((n) => ({ id: `${id}-p${n}` })),
});

describe("addAgent", () => {
  it("adds a pane only to the target workspace", () => {
    const after = addAgent([ws("a", [1]), ws("b", [])], "a", 2);
    expect(after[0].panes).toEqual([{ id: "a-p1" }, { id: "pane-2" }]);
    expect(after[1].panes).toHaveLength(0); // b untouched
  });

  it("respects each workspace's pane cap independently", () => {
    const full = ws(
      "a",
      Array.from({ length: MAX_PANES }, (_, i) => i + 1),
    );
    const after = addAgent([full], "a", 99);
    expect(after[0].panes).toHaveLength(MAX_PANES);
  });
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
