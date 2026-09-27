import { describe, expect, it } from "vitest";
import { openTeamOf, paneInFront, stagePanes } from "./stage";
import { team, teamedWorkspace } from "./reducer.testSupport";
import type { Workspace } from "./workspaces";

/** Two teams: a-1 on team-1, a-2 and a-3 on team-2. */
const twoTeams = (): Workspace => ({
  ...teamedWorkspace("a", ["a-1", "a-2", "a-3"]),
  teams: [team("team-1"), team("team-2")],
  panes: [
    { id: "a-1", team: { teamId: "team-1", role: "lead" } },
    { id: "a-2", team: { teamId: "team-2", role: "lead" } },
    { id: "a-3", team: { teamId: "team-2", role: "impl-1" } },
  ],
});

describe("stagePanes", () => {
  it("lays out one team's members: the opened team's, else the first team's", () => {
    // There is no level above a team: a workspace with teams always has one
    // on the stage.
    const ws = twoTeams();
    expect(stagePanes(ws, undefined).map((pane) => pane.id)).toEqual(["a-1"]);
    expect(stagePanes(ws, {}).map((pane) => pane.id)).toEqual(["a-1"]);
    expect(stagePanes(ws, { teamOpen: "team-2" }).map((pane) => pane.id)).toEqual(["a-2", "a-3"]);
    expect(stagePanes(ws, { teamOpen: "team-1" }).map((pane) => pane.id)).toEqual(["a-1"]);
  });

  it("reads a team the workspace no longer has as the first team", () => {
    // A persisted id can outlive its team; an open nothing would lay out
    // nothing, so the first team stands in.
    const ws = twoTeams();
    expect(openTeamOf(ws, { teamOpen: "team-404" })?.id).toBe("team-1");
    expect(stagePanes(ws, { teamOpen: "team-404" }).map((pane) => pane.id)).toEqual(["a-1"]);
  });

  it("has no team and lays out nothing only for a workspace with no team", () => {
    const bare: Workspace = { ...twoTeams(), teams: [], panes: [] };
    expect(openTeamOf(bare, undefined)).toBeUndefined();
    expect(stagePanes(bare, undefined)).toEqual([]);
  });
});

describe("paneInFront", () => {
  it("is true only for a pane of the OPEN team that is on its grid", () => {
    // The notification probe's half of "on screen": a pane of a team that
    // is not open is never in front of the person, however unhidden it is
    // — an OS banner for it is the right thing, not noise.
    const ws = twoTeams();
    expect(paneInFront(ws, { teamOpen: "team-2" }, "a-2")).toBe(true);
    expect(paneInFront(ws, { teamOpen: "team-2" }, "a-1")).toBe(false);
    expect(paneInFront(ws, { teamOpen: "team-2", minimized: ["a-2"] }, "a-2")).toBe(false);
    // A spotlight on a teammate covers it.
    expect(paneInFront(ws, { teamOpen: "team-2", focus: "a-3" }, "a-2")).toBe(false);
    // With none opened, the first team is the one in front.
    expect(paneInFront(ws, {}, "a-2")).toBe(false);
    expect(paneInFront(ws, undefined, "a-1")).toBe(true);
  });
});
