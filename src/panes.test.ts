import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import { addPane, removePane, type Pane } from "./panes";

const seed = (n: number): Pane[] =>
  Array.from({ length: n }, (_, i) => ({ id: `pane-${i + 1}`, title: `agent-${i + 1}` }));

describe("addPane", () => {
  it("appends a pane numbered by seq", () => {
    expect(addPane([], 1)).toEqual([{ id: "pane-1", title: "agent-1" }]);
    expect(addPane(seed(1), 2)).toEqual([
      { id: "pane-1", title: "agent-1" },
      { id: "pane-2", title: "agent-2" },
    ]);
  });

  it("is a no-op at MAX_PANES (returns the same array)", () => {
    const full = seed(MAX_PANES);
    const result = addPane(full, MAX_PANES + 1);
    expect(result).toBe(full);
    expect(result).toHaveLength(MAX_PANES);
  });
});

describe("removePane", () => {
  it("removes by id and keeps the rest", () => {
    expect(removePane(seed(3), "pane-2")).toEqual([
      { id: "pane-1", title: "agent-1" },
      { id: "pane-3", title: "agent-3" },
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const panes = seed(2);
    expect(removePane(panes, "pane-9")).toEqual(panes);
  });
});
