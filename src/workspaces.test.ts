import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import { addAgent, addWorkspace, closeAgent, type Workspace } from "./workspaces";

const ws = (id: string, paneNums: number[]): Workspace => ({
  id,
  name: id,
  panes: paneNums.map((n) => ({ id: `${id}-p${n}`, title: `agent-${n}` })),
});

describe("addAgent", () => {
  it("adds a pane only to the target workspace", () => {
    const after = addAgent([ws("a", [1]), ws("b", [])], "a", 2);
    expect(after[0].panes).toEqual([
      { id: "a-p1", title: "agent-1" },
      { id: "pane-2", title: "agent-2" },
    ]);
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

describe("closeAgent", () => {
  it("removes a pane only from the target workspace", () => {
    const after = closeAgent([ws("a", [1, 2]), ws("b", [1])], "a", "a-p1");
    expect(after[0].panes.map((p) => p.id)).toEqual(["a-p2"]);
    expect(after[1].panes).toHaveLength(1); // b untouched
  });
});

describe("addWorkspace", () => {
  it("appends an empty workspace", () => {
    const after = addWorkspace([ws("default", [1])], 1);
    expect(after).toHaveLength(2);
    expect(after[1]).toEqual({ id: "ws-1", name: "workspace-1", panes: [] });
  });
});
