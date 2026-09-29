import { describe, expect, it } from "vitest";
import { team, teamedWorkspace, workspace } from "../domain/deck/reducer.testSupport";
import type { Workspace } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import { stripView, workspaceInitials } from "./stripView";

const ONE_TEAM_OF_THREE = teamedWorkspace("ws-a", ["pane-1", "pane-2", "pane-3"]);

const THREE_TEAMS_OF_ONE: Workspace = {
  ...workspace("ws-b", []),
  teams: [team("team-1"), team("team-2"), team("team-3")],
  panes: [
    { id: "pane-4", team: { teamId: "team-1", role: "lead" } },
    { id: "pane-5", team: { teamId: "team-2", role: "lead" } },
    { id: "pane-6", team: { teamId: "team-3", role: "lead" } },
  ],
};

const ACTIVITY: Record<string, PaneActivity> = {
  working: { state: "working", since: 1 },
  waiting: { state: "waiting", since: 1, reason: "permission" },
  done: { state: "done", at: 1, interrupted: false },
  failed: { state: "failed", at: 1, error: "boom" },
};

const frames = (entries: Record<string, keyof typeof ACTIVITY>) =>
  new Map<string, PaneActivity>(
    Object.entries(entries).map(([paneId, state]) => [paneId, ACTIVITY[state]]),
  );

/** A workspace holding one team whose worktree is mid-create, or failed. */
const creatingTeam = (error?: string): Workspace => ({
  ...workspace("ws-c", []),
  teams: [
    {
      id: "team-1",
      name: "team-1",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt", index: 1 }, error },
    },
  ],
});

describe("stripView marks", () => {
  it("carries every workspace the deck holds, in its order, the active one marked", () => {
    // Including one with nothing in it: the column is how a person reaches a
    // workspace, so a mark that disappears takes the way back with it.
    const { marks } = stripView(
      [THREE_TEAMS_OF_ONE, workspace("ws-empty", []), ONE_TEAM_OF_THREE],
      frames({}),
      "ws-a",
    );
    expect(marks.map((m) => [m.id, m.active])).toEqual([
      ["ws-b", false],
      ["ws-empty", false],
      ["ws-a", true],
    ]);
  });

  it("dots a mark with its workspace's loudest state, idle while quiet, none when empty", () => {
    // A mark is the only view into a workspace not on screen, so it says
    // whatever is loudest there — work in progress included.
    const view = (activities: Record<string, keyof typeof ACTIVITY>) =>
      stripView([THREE_TEAMS_OF_ONE], frames(activities), "").marks[0];
    expect(view({}).dot).toBe("idle");
    expect(view({ "pane-6": "done" }).dot).toBe("done");
    expect(view({ "pane-4": "working", "pane-6": "done" }).dot).toBe("working");
    expect(view({ "pane-4": "working", "pane-5": "waiting" }).dot).toBe("waiting");
    expect(view({ "pane-5": "waiting", "pane-6": "failed" })).toMatchObject({
      dot: "failed",
      label: "ws-b — something failed",
    });
    expect(stripView([workspace("ws-e", [])], frames({}), "").marks[0].dot).toBeNull();
  });

  it("says a failed worktree create as loudly as a failed turn, a create in flight not at all", () => {
    expect(stripView([creatingTeam("boom")], frames({}), "").marks[0].dot).toBe("failed");
    expect(stripView([creatingTeam()], frames({}), "").marks[0].dot).toBeNull();
  });
});

describe("stripView active workspace", () => {
  it("names the one on screen and where its menu can move it, refusing past an end", () => {
    const deck = [ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE, workspace("ws-e", [])];
    const at = (id: string) => stripView(deck, frames({}), id).active;
    expect(at("ws-a")).toEqual({ id: "ws-a", name: "ws-a", moveUpTo: null, moveDownTo: 1 });
    expect(at("ws-b")).toMatchObject({ moveUpTo: 0, moveDownTo: 2 });
    expect(at("ws-e")).toMatchObject({ moveUpTo: 1, moveDownTo: null });
    expect(stripView([], frames({}), "").active).toBeNull();
  });
});

describe("workspaceInitials", () => {
  it("takes two words' initials, else a word's first two letters", () => {
    expect(workspaceInitials("KeepDeck")).toBe("KD");
    expect(workspaceInitials("keepdeck.ai")).toBe("ka");
    expect(workspaceInitials("web app")).toBe("wa");
    expect(workspaceInitials("mnemo")).toBe("mn");
    expect(workspaceInitials("")).toBe("?");
  });
});
