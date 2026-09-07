import { describe, expect, it } from "vitest";
import { team, teamedWorkspace, workspace } from "../domain/deck/reducer.testSupport";
import type { Workspace } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import { railView } from "./railView";

/** Three agents divided two ways. The pair is the point: a panel count
 * cannot tell them apart, a team count can, so any reading the rail's
 * number takes is pinned by one of the two. */
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

/** Live activity by pane, the shape one subscription hands in. */
const frames = (entries: Record<string, keyof typeof ACTIVITY>) =>
  new Map<string, PaneActivity>(
    Object.entries(entries).map(([paneId, state]) => [paneId, ACTIVITY[state]]),
  );

/** A workspace holding one team whose worktree is mid-create, or failed —
 * a team with no members at all, which the old fold over panes could not
 * see. */
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

describe("railView", () => {
  it("carries every workspace the deck holds, in the deck's order", () => {
    // Including one with nothing in it: the rail is how a person reaches a
    // workspace, so a row that disappears takes the way back with it.
    const rows = railView(
      [THREE_TEAMS_OF_ONE, workspace("ws-empty", []), ONE_TEAM_OF_THREE],
      frames({}),
      {},
      "",
    );
    expect(rows.map((row) => row.id)).toEqual(["ws-b", "ws-empty", "ws-a"]);
  });

  it("carries the name, and marks the active workspace green", () => {
    const rows = railView([ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE], frames({}), {}, "ws-a");
    expect(rows[0].name).toBe("ws-a");
    expect(rows[0].dot).toBe("selected");
    expect(rows[1].dot).toBe("none");
  });

  it("counts the teams in a workspace, not the agents on them", () => {
    const [oneTeam, threeTeams] = railView(
      [ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE],
      frames({}),
      {},
      "",
    );
    expect(oneTeam.teamCount).toBe(1);
    expect(threeTeams.teamCount).toBe(3);
  });

  it("counts a team with nobody on it — it is still a team", () => {
    const bornEmpty: Workspace = { ...workspace("ws-new", []), teams: [team("team-9")] };
    const [row] = railView([bornEmpty], frames({}), {}, "");
    expect(row.teamCount).toBe(1);
  });
});

describe("railView expansion", () => {
  it("lists a workspace's teams only when the person opened it", () => {
    const collapsed = railView([ONE_TEAM_OF_THREE], frames({}), {}, "");
    const opened = railView([ONE_TEAM_OF_THREE], frames({}), {
      "ws-a": { railExpanded: true },
    }, "");
    expect(collapsed[0].expanded).toBe(false);
    expect(opened[0].expanded).toBe(true);
    // The teams ride either way: whether to SHOW them is the row's own
    // question, and a row that had to be re-derived to answer it would
    // answer it differently.
    expect(collapsed[0].teams).toHaveLength(1);
  });

  it("is never open with nothing to list", () => {
    // The chevron has nothing to turn, so a row claiming to be open would
    // be making a promise it cannot keep.
    const [row] = railView([workspace("ws-bare", [])], frames({}), {
      "ws-bare": { railExpanded: true },
    }, "");
    expect(row.expanded).toBe(false);
  });
});

describe("railView dots", () => {
  it("folds a workspace's dot from its teams, loudest first", () => {
    // Two rounds of one ladder: each team from its members, the workspace
    // from its teams. Max is associative, so a member needing the person
    // reaches the rail through its team exactly as it used to reach it
    // directly.
    const [row] = railView(
      [THREE_TEAMS_OF_ONE],
      frames({ "pane-4": "working", "pane-5": "waiting", "pane-6": "done" }),
      {},
      "",
    );
    expect(row.dot).toBe("waiting");
    expect(row.teams.map((t) => t.dot)).toEqual(["working", "waiting", "done"]);
  });

  it("lets attention through the active workspace's green", () => {
    const [row] = railView([ONE_TEAM_OF_THREE], frames({ "pane-2": "failed" }), {}, "ws-a");
    expect(row.dot).toBe("failed");
  });

  it("says a failed worktree create as loudly as a failed turn", () => {
    // The blind spot this whole reading exists to close: the team has no
    // members to have an activity, so the old fold over panes saw nothing
    // and the rail said nothing — while until Retry, nothing on that team
    // can run at all.
    const [row] = railView([creatingTeam("boom")], frames({}), {}, "");
    expect(row.teams[0].dot).toBe("failed");
    expect(row.dot).toBe("failed");
  });

  it("keeps a create in flight quiet on the workspace, and named on its team", () => {
    // The card already decided a create must never read as the person's
    // turn, and a seven-pixel dot has no room to say it more gently. The
    // team's own row still carries it, one chevron away.
    const [row] = railView([creatingTeam()], frames({}), {}, "");
    expect(row.teams[0].dot).toBe("creating");
    expect(row.dot).toBe("none");
  });

  it("gives a workspace whose teams are quiet the bare gray dot", () => {
    const [row] = railView([ONE_TEAM_OF_THREE], frames({}), {}, "");
    expect(row.dot).toBe("none");
  });
});
