import { describe, expect, it } from "vitest";
import type { Team, Workspace } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { teamCardView } from "./teamCardView";

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

const ws = (teams: Team[], members: Record<string, number>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: "/repo/.wt",
  teams,
  panes: teams.flatMap((team) =>
    Array.from({ length: members[team.id] ?? 0 }, (_, index) => ({
      id: `${team.id}-p${index + 1}`,
      team: { teamId: team.id, role: `impl-${index + 1}` },
    })),
  ),
});

const working: PaneActivity = { state: "working", since: 1 };
const waiting: PaneActivity = { state: "waiting", since: 2, reason: "permission" };
const done: PaneActivity = { state: "done", at: 3, interrupted: false };
const crashed: PaneActivity = { state: "failed", at: 4, error: "rate_limit" };

describe("teamCardView", () => {
  it("is six things: dot, name, menu, branch, size, directory — and nothing about the members", () => {
    const view = teamCardView(ws([attached], { "team-1": 3 }), attached, [working, done, undefined]);
    expect(view).toEqual({
      id: "team-1",
      name: "api",
      branch: "kd/api",
      cwd: "/repo/.wt/api",
      size: 3,
      dot: "working",
      pending: false,
      actions: ["add-member", "rename", "disband"],
    });
  });

  it("prefers the live head's branch over the one on record, and has none for a bare directory", () => {
    const deck = ws([attached], { "team-1": 1 });
    expect(teamCardView(deck, attached, [], { branch: "kd/api-v2", head: "abc" }).branch).toBe(
      "kd/api-v2",
    );
    // A detached head names no branch; the record still does.
    expect(teamCardView(deck, attached, [], { head: "abc" }).branch).toBe("kd/api");
    const root: Team = { id: "team-9", name: "root", location: { kind: "attached", cwd: "/repo" } };
    expect(teamCardView(ws([root], {}), root, []).branch).toBeNull();
  });

  it("shows a team whose directory is on its way as pending, at the path it is heading for", () => {
    const view = teamCardView(ws([creating], { "team-2": 1 }), creating, [undefined]);
    expect(view).toMatchObject({
      branch: "kd/web",
      cwd: "/repo/.wt/web",
      dot: "creating",
      pending: true,
      actions: ["add-member", "rename", "disband"],
    });
  });

  it("offers Retry — in the menu, and only — once the create failed", () => {
    const view = teamCardView(ws([failed], { "team-3": 1 }), failed, [undefined]);
    expect(view.dot).toBe("failed");
    expect(view.pending).toBe(true);
    expect(view.actions).toEqual(["add-member", "rename", "disband", "retry"]);
    // The error's words are not the card's: nothing here carries them.
    expect(JSON.stringify(view)).not.toContain("branch exists");
  });

  it("folds the members' activity to one dot on the rail's ladder, with the team's own rungs in it", () => {
    const deck = ws([attached, failed], { "team-1": 2, "team-3": 1 });
    // Louder member wins; a finished turn is the quietest thing said.
    expect(teamCardView(deck, attached, [done, working]).dot).toBe("working");
    expect(teamCardView(deck, attached, [done]).dot).toBe("done");
    expect(teamCardView(deck, attached, []).dot).toBe("none");
    expect(teamCardView(deck, attached, [working, waiting]).dot).toBe("waiting");
    expect(teamCardView(deck, attached, [waiting, crashed]).dot).toBe("failed");
    // A member needing the person outranks a directory that is not there;
    // a failed create outranks any quieter member.
    expect(teamCardView(deck, failed, [waiting]).dot).toBe("waiting");
    expect(teamCardView(deck, failed, [working]).dot).toBe("failed");
  });

  it("counts a team of one exactly like a team of many", () => {
    const deck = ws([attached], { "team-1": 1 });
    const one = teamCardView(deck, attached, [working]);
    const many = teamCardView(ws([attached], { "team-1": 4 }), attached, [working]);
    expect({ ...one, size: 0 }).toEqual({ ...many, size: 0 });
    expect(one.size).toBe(1);
    expect(many.size).toBe(4);
  });
});
