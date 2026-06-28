import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import { addPane, makePanes, removePane, type Pane } from "./panes";

const seed = (n: number): Pane[] =>
  Array.from({ length: n }, (_, i) => ({ id: `pane-${i + 1}` }));

describe("addPane", () => {
  it("appends a pane numbered by seq", () => {
    expect(addPane([], 1)).toEqual([{ id: "pane-1" }]);
    expect(addPane(seed(1), 2)).toEqual([{ id: "pane-1" }, { id: "pane-2" }]);
  });

  it("is a no-op at MAX_PANES (returns the same array)", () => {
    const full = seed(MAX_PANES);
    const result = addPane(full, MAX_PANES + 1);
    expect(result).toBe(full);
    expect(result).toHaveLength(MAX_PANES);
  });
});

describe("makePanes", () => {
  it("builds count panes numbered from startSeq", () => {
    expect(makePanes(3, 2)).toEqual([{ id: "pane-3" }, { id: "pane-4" }]);
  });

  it("clamps to MAX_PANES and never goes negative", () => {
    expect(makePanes(1, MAX_PANES + 5)).toHaveLength(MAX_PANES);
    expect(makePanes(1, 0)).toEqual([]);
    expect(makePanes(1, -2)).toEqual([]);
  });
});

describe("removePane", () => {
  it("removes by id and keeps the rest", () => {
    expect(removePane(seed(3), "pane-2")).toEqual([
      { id: "pane-1" },
      { id: "pane-3" },
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const panes = seed(2);
    expect(removePane(panes, "pane-9")).toEqual(panes);
  });
});
