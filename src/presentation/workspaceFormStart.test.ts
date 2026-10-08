import { describe, expect, it } from "vitest";
import { workspaceFormStart } from "./workspaceFormStart";

describe("how the workspace form starts", () => {
  it("on its own: empty, leaving by Cancel", () => {
    expect(workspaceFormStart(null)).toEqual({ name: "", cwd: null, leave: "Cancel", folderFixed: false, className: "form" });
  });

  it("confirming a chosen folder: named after it, the folder fixed, leaving by Back", () => {
    expect(workspaceFormStart("/Users/me/Projects/SmokeR24.1-kernel/")).toEqual({
      name: "SmokeR24.1-kernel",
      cwd: "/Users/me/Projects/SmokeR24.1-kernel/",
      leave: "Back",
      folderFixed: true,
      className: "form form--confirm",
    });
  });
});
