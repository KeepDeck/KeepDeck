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
    );
    expect(rows.map((row) => row.id)).toEqual(["ws-b", "ws-empty", "ws-a"]);
  });

  it("carries the name and paints the dot from the folded frame", () => {
    const rows = railView(
      [ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE],
      frames({ "ws-a": "selected", "ws-b": "failed" }),
    );
    expect(rows[0].name).toBe("ws-a");
    expect(rows[0].dot).toBe("selected");
    expect(rows[1].dot).toBe("failed");
  });

  it("wears the bare gray dot for a workspace the tracker has not folded", () => {
    const [row] = railView([ONE_TEAM_OF_THREE], frames({ "ws-other": "working" }));
    expect(row.dot).toBe("none");
  });

  it("counts the agents in a workspace, however its teams divide them", () => {
    const [oneTeam, threeTeams] = railView(
      [ONE_TEAM_OF_THREE, THREE_TEAMS_OF_ONE],
      frames({}),
    );
    expect(oneTeam.agentCount).toBe(3);
    expect(threeTeams.agentCount).toBe(3);
  });
});
