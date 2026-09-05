import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { bellDoorOpen, dockDoorOpen, teamDialogDoorOpen } from "./doors";

const workspace: Workspace = {
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
};

describe("the top bar's doors", () => {
  it("offers the team dialog only with a live workspace to build a team in", () => {
    expect(teamDialogDoorOpen(workspace)).toBe(true);
    expect(teamDialogDoorOpen(null)).toBe(false);
  });

  it("offers the dock toggle only when a plugin contributed a tab to open onto", () => {
    expect(dockDoorOpen(1)).toBe(true);
    expect(dockDoorOpen(0)).toBe(false);
  });

  it("offers the bell only when notifications are on and the app keeps its own list", () => {
    expect(bellDoorOpen({ enabled: true, mode: "app" })).toBe(true);
    expect(bellDoorOpen({ enabled: true, mode: "system-and-app" })).toBe(true);
    // The OS carries the banners and the history: nothing for a bell to open.
    expect(bellDoorOpen({ enabled: true, mode: "system" })).toBe(false);
    expect(bellDoorOpen({ enabled: false, mode: "app" })).toBe(false);
  });
});
