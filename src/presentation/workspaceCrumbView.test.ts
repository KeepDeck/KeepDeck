import { describe, expect, it } from "vitest";
import { workspaceMenuView } from "./workspaceCrumbView";

describe("workspaceMenuView", () => {
  it("offers rename, both moves and close, a move refused past its end", () => {
    expect(workspaceMenuView({ id: "a", name: "A", moveUp: null, moveDown: { after: "b" } })).toEqual([
      { id: "rename", kind: "rename", label: "Rename", disabled: false },
      { id: "up", kind: "move", label: "Move up", place: null, disabled: true },
      { id: "down", kind: "move", label: "Move down", place: { after: "b" }, disabled: false },
      { id: "close", kind: "close", label: "Close workspace", disabled: false },
    ]);
  });
});