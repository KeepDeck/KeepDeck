import { describe, expect, it } from "vitest";
import { workspaceMenuView } from "./workspaceCrumbView";

describe("workspaceMenuView", () => {
  it("offers rename, both moves and close, a move refused past its end", () => {
    expect(workspaceMenuView({ id: "a", name: "A", moveUpTo: null, moveDownTo: 1 })).toEqual([
      { id: "rename", kind: "rename", label: "Rename", disabled: false },
      { id: "up", kind: "move", label: "Move up", to: null, disabled: true },
      { id: "down", kind: "move", label: "Move down", to: 1, disabled: false },
      { id: "close", kind: "close", label: "Close workspace", disabled: false },
    ]);
  });
});