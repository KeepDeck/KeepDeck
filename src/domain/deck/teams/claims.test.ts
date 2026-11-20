import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import { directoryHolder, normalizePath, sameDirectory, teamHeldPath } from "./claims";

describe("a team's directory as a path", () => {
  it("is the folder a team runs in, or the one its create is heading for — none without a location", () => {
    expect(teamHeldPath({ location: { kind: "attached", cwd: "/wt/a" } })).toBe("/wt/a");
    expect(
      teamHeldPath({ location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/b", index: 1 } } }),
    ).toBe("/wt/b");
    expect(teamHeldPath({ location: undefined })).toBeUndefined();
  });

  it("names one folder however its edges are spelled, and never empties a root", () => {
    expect(normalizePath(" /wt/a// ")).toBe("/wt/a");
    expect(normalizePath("/")).toBe("/");
    expect(sameDirectory("/repo/", "/repo")).toBe(true);
    expect(sameDirectory("/repo", "/repo2")).toBe(false);
  });
});

describe("directoryHolder", () => {
  const ws = (id: string, name: string, teams: { id: string; name: string }[]) => ({
    id,
    instance: createWorkspaceInstance(),
    name,
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [],
    teams: teams.map((team) => ({ ...team, location: { kind: "attached" as const, cwd: "/wt/a" } })),
  });
  const deck = [ws("ws-1", "one", [{ id: "team-1", name: "api" }]), ws("ws-2", "two", [{ id: "team-2", name: "web" }])];

  it("names a holder here by its team, and one elsewhere with its workspace too", () => {
    expect(directoryHolder(deck, ["team-1"], "ws-1", "anywhere")).toEqual({ teamId: "team-1", teamName: "api" });
    expect(directoryHolder(deck, ["team-2"], "ws-1", "anywhere")).toEqual({ teamId: "team-2", teamName: "web", workspace: "two" });
  });

  it("holds a workspace's own root only by its own teams", () => {
    expect(directoryHolder(deck, ["team-2"], "ws-1", "here")).toBeNull();
    expect(directoryHolder(deck, ["team-2", "team-1"], "ws-1", "here")).toEqual({ teamId: "team-1", teamName: "api" });
  });

  it("skips a team the deck no longer holds, and answers null when none is left", () => {
    expect(directoryHolder(deck, ["team-gone", "team-2"], "ws-2", "anywhere")).toEqual({ teamId: "team-2", teamName: "web" });
    expect(directoryHolder(deck, ["team-gone"], "ws-1", "anywhere")).toBeNull();
    expect(directoryHolder(deck, [], "ws-1", "anywhere")).toBeNull();
  });
});
