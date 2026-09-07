import { describe, expect, it } from "vitest";
import { team, teamedWorkspace, workspace } from "../domain/deck/reducer.testSupport";
import type { Workspace } from "../domain/deck";
import type { StatusFrame } from "../domain/status";
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

const frames = (entries: Record<string, StatusFrame>) =>
  new Map<string, StatusFrame>(Object.entries(entries));

describe("railView", () => {
  it("carries every workspace the deck holds, in the deck's order", () => {
    // Including one with nothing in it: the rail is how a person reaches a
    // workspace, so a row that disappears takes the way back with it.
    const rows = railView(
      [THREE_TEAMS_OF_ONE, workspace("ws-empty", []), ONE_TEAM_OF_THREE],
      frames({}),
      {},
    );
    expect(rows.map((row) => row.id)).toEqual(["ws-b", "ws-empty", "ws-a"]);
  });

  it("carries the name and paints the dot from the folded frame", () => {
    const rows = railView(
      [ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE],
      frames({ "ws-a": "selected", "ws-b": "failed" }),
      {},
    );
    expect(rows[0].name).toBe("ws-a");
    expect(rows[0].dot).toBe("selected");
    expect(rows[1].dot).toBe("failed");
  });

  it("wears the bare gray dot for a workspace the tracker has not folded", () => {
    const [row] = railView([ONE_TEAM_OF_THREE], frames({ "ws-other": "working" }), {});
    expect(row.dot).toBe("none");
  });

  it("counts the teams in a workspace, not the agents on them", () => {
    const [oneTeam, threeTeams] = railView(
      [ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE],
      frames({}),
      {},
    );
    expect(oneTeam.teamCount).toBe(1);
    expect(threeTeams.teamCount).toBe(3);
  });

  it("counts a team with nobody on it — it is still a team", () => {
    const bornEmpty: Workspace = { ...workspace("ws-new", []), teams: [team("team-9")] };
    const [row] = railView([bornEmpty], frames({}), {});
    expect(row.teamCount).toBe(1);
  });
});

describe("railView expansion", () => {
  it("lists a workspace's teams only when the person opened it", () => {
    const collapsed = railView([ONE_TEAM_OF_THREE], frames({}), {});
    const opened = railView([ONE_TEAM_OF_THREE], frames({}), {
      "ws-a": { railExpanded: true },
    });
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
    });
    expect(row.expanded).toBe(false);
  });
});
