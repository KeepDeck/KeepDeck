import { describe, expect, it } from "vitest";
import type { Team } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import { TEAM_WORDS, teamActions, teamBranchOf, teamDot, teamPending } from "./teamView";

const attached: Team = {
  id: "team-1",
  name: "api",
  location: { kind: "attached", cwd: "/repo/.wt/api", branch: "kd/api" },
};
const creating: Team = {
  id: "team-2",
  name: "web",
  location: {
    kind: "provisioning",
    intent: { repo: "/repo", path: "/repo/.wt/web", branch: "kd/web", index: 2 },
  },
};
const failed: Team = {
  ...creating,
  id: "team-3",
  name: "docs",
  location: { ...creating.location, error: "branch exists" } as Team["location"],
};

const working: PaneActivity = { state: "working", since: 1 };
const waiting: PaneActivity = { state: "waiting", since: 2, reason: "permission" };
const done: PaneActivity = { state: "done", at: 3, interrupted: false };
const crashed: PaneActivity = { state: "failed", at: 4, error: "rate_limit" };

describe("teamBranchOf", () => {
  it("prefers the live head's branch over the one on record, and has none for a bare directory", () => {
    expect(teamBranchOf(attached, { branch: "kd/api-v2", head: "abc" })).toBe("kd/api-v2");
    // A detached head names no branch; the record still does.
    expect(teamBranchOf(attached, { head: "abc" })).toBe("kd/api");
    expect(teamBranchOf(creating)).toBe("kd/web");
    const root: Team = { id: "team-9", name: "root", location: { kind: "attached", cwd: "/repo" } };
    expect(teamBranchOf(root)).toBeNull();
  });
});

describe("teamDot", () => {
  it("folds the members' activity to one dot, with the team's own rungs in it", () => {
    // Louder member wins; a finished turn is the quietest thing said.
    expect(teamDot(attached, [done, working])).toBe("working");
    expect(teamDot(attached, [done])).toBe("done");
    expect(teamDot(attached, [])).toBe("none");
    expect(teamDot(attached, [working, waiting])).toBe("waiting");
    expect(teamDot(attached, [waiting, crashed])).toBe("failed");
    expect(teamDot(creating, [undefined])).toBe("creating");
    // A member needing the person outranks a directory that is not there;
    // a failed create outranks any quieter member.
    expect(teamDot(failed, [waiting])).toBe("waiting");
    expect(teamDot(failed, [working])).toBe("failed");
  });
});

describe("teamActions and teamPending", () => {
  it("offers Retry only once the create failed, and calls a missing directory pending", () => {
    expect(teamActions(attached)).toEqual(["add-member", "rename", "disband"]);
    expect(teamActions(creating)).toEqual(["add-member", "rename", "disband"]);
    expect(teamActions(failed)).toEqual(["add-member", "rename", "disband", "retry"]);
    expect([attached, creating, failed].map(teamPending)).toEqual([false, true, true]);
  });
});

describe("TEAM_WORDS", () => {
  it("counts agents in words, and names the menu after the team", () => {
    expect(TEAM_WORDS.agents(0)).toBe("No agents");
    expect(TEAM_WORDS.agents(1)).toBe("1 agent");
    expect(TEAM_WORDS.agents(3)).toBe("3 agents");
    expect(TEAM_WORDS.menu("api")).toBe("Team api actions");
    expect(TEAM_WORDS.action.retry).toBe("Retry the worktree");
  });
});
