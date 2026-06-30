import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  appendPane,
  makePanes,
  removePane,
  resolveFocus,
  type Pane,
} from "./panes";

const seed = (n: number): Pane[] =>
  Array.from({ length: n }, (_, i) => ({ id: `pane-${i + 1}` }));

describe("appendPane", () => {
  it("appends an already-formed pane (worktree fields preserved)", () => {
    const pane = { id: "pane-2", cwd: "/wt/2", branch: "kd/ws/2" };
    expect(appendPane(seed(1), pane)).toEqual([{ id: "pane-1" }, pane]);
  });

  it("is a no-op at MAX_PANES (returns the same array)", () => {
    const full = seed(MAX_PANES);
    expect(appendPane(full, { id: "overflow" })).toBe(full);
  });
});

describe("makePanes", () => {
  it("builds count panes from startSeq, all of the given type", () => {
    expect(makePanes(3, 2, "claude")).toEqual([
      { id: "pane-3", agentType: "claude" },
      { id: "pane-4", agentType: "claude" },
    ]);
  });

  it("clamps to MAX_PANES and never goes negative", () => {
    expect(makePanes(1, MAX_PANES + 5, "claude")).toHaveLength(MAX_PANES);
    expect(makePanes(1, 0, "claude")).toEqual([]);
    expect(makePanes(1, -2, "claude")).toEqual([]);
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

describe("resolveFocus", () => {
  it("returns the focused pane id when it's one of several panes", () => {
    expect(resolveFocus(seed(3), "pane-2")).toBe("pane-2");
  });

  it("returns null for a solo pane — maximize is a no-op ([U1])", () => {
    expect(resolveFocus(seed(1), "pane-1")).toBeNull();
  });

  it("returns null when the focused id no longer matches any pane", () => {
    // The maximized pane was closed, leaving others behind.
    expect(resolveFocus(seed(3), "pane-9")).toBeNull();
  });

  it("returns null when nothing is focused", () => {
    expect(resolveFocus(seed(3), undefined)).toBeNull();
  });

  it("returns null for an empty workspace", () => {
    expect(resolveFocus([], "pane-1")).toBeNull();
  });
});
