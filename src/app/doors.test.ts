import { describe, expect, it } from "vitest";
import { MAX_PANES, TEAM_FULL_MESSAGE, type Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { addTeamDoorOpen, bellDoorOpen, dockDoorOpen, memberDoor } from "./doors";

const workspace: Workspace = {
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
};

describe("the top bar's doors", () => {
  it("offers a new team only with a live workspace to put it in", () => {
    expect(addTeamDoorOpen(workspace)).toBe(true);
    expect(addTeamDoorOpen(null)).toBe(false);
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

describe("memberDoor", () => {
  const withMembers = (n: number) => ({
    panes: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, team: { teamId: "t", role: `r${i}` } })),
  });

  it("opens onto a team with room, stays shut under a dialog without a word", () => {
    expect(memberDoor(withMembers(3), "t", false)).toEqual({ open: true, refusal: null });
    expect(memberDoor(withMembers(3), "t", true)).toEqual({ open: false, refusal: null });
  });

  it("refuses a full team in the cap's own words, dialog or not", () => {
    const full = withMembers(MAX_PANES);
    expect(memberDoor(full, "t", false)).toEqual({ open: false, refusal: TEAM_FULL_MESSAGE });
    expect(memberDoor(full, "t", true)).toEqual({ open: false, refusal: TEAM_FULL_MESSAGE });
    // Another team in the same workspace is not full.
    expect(memberDoor(full, "other", false).open).toBe(true);
  });
});
