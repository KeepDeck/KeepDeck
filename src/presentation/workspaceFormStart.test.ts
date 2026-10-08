import { describe, expect, it } from "vitest";
import { workspaceFormStart } from "./workspaceFormStart";

describe("how the workspace form starts", () => {
  it("on its own: empty, where worktrees go in view, leaving by Cancel", () => {
    expect(workspaceFormStart(null)).toEqual({ name: "", cwd: null, advanced: { foldable: false, open: true }, leave: "Cancel" });
  });

  it("confirming a chosen folder: named after it, where worktrees go folded, leaving by Back", () => {
    expect(workspaceFormStart("/Users/me/Projects/SmokeR24.1-kernel/")).toEqual({
      name: "SmokeR24.1-kernel",
      cwd: "/Users/me/Projects/SmokeR24.1-kernel/",
      advanced: { foldable: true, open: false },
      leave: "Back",
    });
  });
});
