import { describe, expect, it } from "vitest";
import type { PaneActivity } from "../status";
import { blockedAgents } from "./attention";
import { team, teamedWorkspace, workspace } from "./reducer.testSupport";
import type { Workspace } from "./workspaces";

const waiting = (since: number): PaneActivity => ({ state: "waiting", since, reason: "question" });
const failed = (at: number): PaneActivity => ({ state: "failed", at, error: "x" });

const A = teamedWorkspace("a", ["a1", "a2", "a3"]);
const B: Workspace = {
  ...workspace("b", []),
  teams: [team("tb")],
  panes: [
    { id: "b1", team: { teamId: "tb", role: "lead" } },
    { id: "b2", idle: { reason: "suspended", at: "x" }, team: { teamId: "tb", role: "r" } },
    { id: "b3" },
  ],
};

const ids = (activities: Record<string, PaneActivity>) =>
  blockedAgents([A, B], new Map(Object.entries(activities))).map((b) => b.pane.id);

describe("blockedAgents", () => {
  it("lists only agents that need a person, louder first, then the longest blocked", () => {
    expect(
      ids({
        a1: { state: "working", since: 0 },
        a2: waiting(5),
        a3: failed(9),
        b1: waiting(1),
      }),
    ).toEqual(["a3", "b1", "a2"]);
  });

  it("skips an idle pane and a pane outside every team — neither can be brought forward", () => {
    expect(ids({ b2: failed(1), b3: failed(1) })).toEqual([]);
  });

  it("carries the team and the moment it became blocked", () => {
    const [only] = blockedAgents([A], new Map([["a2", waiting(7)]]));
    expect(only).toMatchObject({ index: 1, since: 7, team: { id: "team-1" } });
  });
});
