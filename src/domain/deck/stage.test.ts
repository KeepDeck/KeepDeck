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
  it("lays out nothing at the cards level, and one team's members inside it", () => {
    const ws = twoTeams();
    expect(stagePanes(ws, undefined)).toEqual([]);
    expect(stagePanes(ws, {})).toEqual([]);
    expect(stagePanes(ws, { teamOpen: "team-2" }).map((pane) => pane.id)).toEqual(["a-2", "a-3"]);
    expect(stagePanes(ws, { teamOpen: "team-1" }).map((pane) => pane.id)).toEqual(["a-1"]);
  });

  it("reads a team the workspace no longer has as the cards level", () => {
    // A persisted id can outlive its team; an open nothing would lay out
    // nothing AND offer no way back, so it is the cards level instead.
    const ws = twoTeams();
    expect(openTeamOf(ws, { teamOpen: "team-404" })).toBeUndefined();
    expect(stagePanes(ws, { teamOpen: "team-404" })).toEqual([]);
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
    // At the cards level nobody is in front.
    expect(paneInFront(ws, {}, "a-2")).toBe(false);
    expect(paneInFront(ws, undefined, "a-1")).toBe(false);
  });
});
