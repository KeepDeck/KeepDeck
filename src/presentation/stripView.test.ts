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
      {},
      "ws-a",
    );
    expect(marks.map((m) => [m.id, m.active])).toEqual([
      ["ws-b", false],
      ["ws-empty", false],
      ["ws-a", true],
    ]);
  });

  it("dots a workspace only for what needs the person, failed over waiting", () => {
    const view = (activities: Record<string, keyof typeof ACTIVITY>) =>
      stripView([THREE_TEAMS_OF_ONE], frames(activities), {}, "")?.marks[0];
    expect(view({ "pane-4": "working", "pane-6": "done" }).dot).toBeNull();
    expect(view({ "pane-4": "working", "pane-5": "waiting" }).dot).toBe("waiting");
    expect(view({ "pane-5": "waiting", "pane-6": "failed" })).toMatchObject({
      dot: "failed",
      label: "ws-b — something failed",
    });
  });

  it("says a failed worktree create as loudly as a failed turn, a create in flight not at all", () => {
    expect(stripView([creatingTeam("boom")], frames({}), {}, "").marks[0].dot).toBe("failed");
    expect(stripView([creatingTeam()], frames({}), {}, "").marks[0].dot).toBeNull();
  });
});

describe("stripView teams", () => {
  it("lists the active workspace's teams, with the one on the stage open", () => {
    const { teams } = stripView([ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE], frames({}), {
      "ws-b": { teamOpen: "team-2" },
    }, "ws-b");
    expect(teams?.wsId).toBe("ws-b");
    expect(teams?.rows.map((r) => [r.id, r.open, r.size])).toEqual([
      ["team-1", false, 1],
      ["team-2", true, 1],
      ["team-3", false, 1],
    ]);
  });

  it("opens the first team when none was picked — there is no level above a team", () => {
    const { teams } = stripView([THREE_TEAMS_OF_ONE], frames({}), {}, "ws-b");
    expect(teams?.rows.map((r) => r.open)).toEqual([true, false, false]);
  });

  it("dots a row for attention only, dims a pending one, offers Retry for a failed create", () => {
    const { teams } = stripView(
      [THREE_TEAMS_OF_ONE],
      frames({ "pane-4": "working", "pane-5": "waiting", "pane-6": "failed" }),
      {},
      "ws-b",
    );
    expect(teams?.rows.map((r) => r.dot)).toEqual([null, "waiting", "failed"]);
    const [failedCreate] = stripView([creatingTeam("boom")], frames({}), {}, "ws-c").teams!.rows;
    expect(failedCreate).toMatchObject({ pending: true, dot: "failed" });
    expect(failedCreate.actions).toContain("retry");
  });

  it("has no list for a deck with no workspace, and an empty one for a bare workspace", () => {
    expect(stripView([], frames({}), {}, "").teams).toBeNull();
    expect(stripView([workspace("ws-e", [])], frames({}), {}, "ws-e").teams?.rows).toEqual([]);
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
