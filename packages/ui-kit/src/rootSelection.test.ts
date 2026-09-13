import { describe, expect, it } from "vitest";
import {
  followRootSelection,
  initialRootSelection,
  type RootSelectionInput,
} from "./rootSelection";

const panes = [
  { id: "p1", cwd: "/wt/one" },
  { id: "p2", cwd: "/wt/two" },
  { id: "p3" }, // still provisioning: no directory yet
];
const input = (over: Partial<RootSelectionInput>): RootSelectionInput => ({
  selectedPaneId: null,
  panes,
  fallback: "/repo",
  roots: ["/wt/one", "/wt/two", "/repo"],
  ...over,
});

describe("rootSelection", () => {
  it("starts on the highlight's directory, or the workspace folder", () => {
    expect(initialRootSelection(input({ selectedPaneId: "p1" }))).toEqual({
      target: "/wt/one",
      seenSelected: "p1",
    });
    expect(initialRootSelection(input({}))).toEqual({ target: "/repo", seenSelected: null });
    // A highlighted pane with no directory yet lands on the workspace folder.
    expect(initialRootSelection(input({ selectedPaneId: "p3" })).target).toBe("/repo");
  });

  it("follows a CHANGED highlight and keeps a hand pick until it changes", () => {
    const start = initialRootSelection(input({ selectedPaneId: "p1" }));
    // A hand pick.
    const picked = { ...start, target: "/wt/two" };
    // Same highlight re-rendered: the pick holds, and the object is the same.
    expect(followRootSelection(picked, input({ selectedPaneId: "p1" }))).toBe(picked);
    // The highlight moves: the tab follows it.
    expect(followRootSelection(picked, input({ selectedPaneId: "p1" }))).toBe(picked);
    const followed = followRootSelection(picked, input({ selectedPaneId: "p2" }));
    expect(followed).toEqual({ target: "/wt/two", seenSelected: "p2" });
    const again = followRootSelection(followed, input({ selectedPaneId: "p1" }));
    expect(again.target).toBe("/wt/one");
  });

  it("a highlight without a directory leaves the target where it was", () => {
    const start = initialRootSelection(input({ selectedPaneId: "p1" }));
    const next = followRootSelection(start, input({ selectedPaneId: "p3" }));
    expect(next).toEqual({ target: "/wt/one", seenSelected: "p3" });
  });

  it("a root that vanished snaps to the highlight's directory, else the folder", () => {
    // The team was disbanded and its worktree removed: the dropdown no
    // longer offers it, and the status read would fail forever on it.
    const start = { target: "/wt/gone", seenSelected: "p1" };
    expect(
      followRootSelection(start, input({ selectedPaneId: "p1", roots: ["/wt/one", "/repo"] })),
    ).toEqual({ target: "/wt/one", seenSelected: "p1" });
    expect(
      followRootSelection(start, input({ selectedPaneId: null, roots: ["/repo"] })),
    ).toEqual({ target: "/repo", seenSelected: null });
  });
});
