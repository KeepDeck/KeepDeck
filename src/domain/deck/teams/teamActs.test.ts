import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Pane } from "../panes";
import type { AgentReach } from "../runIntent";
import type { Workspace } from "../workspaces";
import type { TeamLocation } from "./model";
import { stillTaken, teamActsOf, teamResumeCohort, teamSuspendCohort, type TeamActFacts } from "./teamActs";

const AT = "2026-11-19T10:00:00.000Z";
const on = (teamId: string, pane: Omit<Pane, "agentType" | "team"> & Partial<Pane>): Pane => ({
  agentType: "claude",
  team: { teamId, role: pane.id },
  ...pane,
});

/** One team holding a member in every state a team act has to answer for,
 * and a second team still creating its directory. */
const deck = (extra: Partial<Workspace> = {}): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws-1",
  cwd: "/repo",
  worktreeBaseDir: null,
  teams: [
    { id: "team-1", name: "one", location: { kind: "attached", cwd: "/repo" } },
    {
      id: "team-2",
      name: "two",
      location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/two", index: 2 } },
    },
  ],
  panes: [
    on("team-1", { id: "live" }),
    on("team-1", { id: "parked", idle: { reason: "parked" } }),
    on("team-1", { id: "suspended", idle: { reason: "suspended", at: AT } }),
    on("team-1", { id: "rising", idle: { reason: "waking", origin: "restore" } }),
    on("team-1", { id: "remote", idle: { reason: "parked" }, location: { kind: "remote", endpoint: "ssh://box" } }),
    on("team-1", { id: "remote-live", location: { kind: "remote", endpoint: "ssh://box" } }),
    // As the sweep leaves it: still marked rising, its folder found gone.
    on("team-1", { id: "folder-gone", idle: { reason: "waking", origin: "restore" } }),
    on("team-1", { id: "no-agent", agentType: "kimi", idle: { reason: "suspended", at: AT } }),
    // Still being reaped by a suspend, and asked back meanwhile: rising.
    on("team-1", { id: "reaping", idle: { reason: "waking", origin: "manual" } }),
    on("team-2", { id: "creating" }),
  ],
  ...extra,
});

const facts: TeamActFacts = {
  blocked: (paneId) => paneId === "folder-gone",
  agentAvailable: (agentType) => agentType === "claude",
  suspending: (paneId) => paneId === "reaping",
  // Nothing known of any process: each member is judged on its own.
  reach: () => null,
  gates: (teamId) => (teamId === "team-1" ? { addMember: { kind: "targetLeaving" }, close: null, retry: null } : null),
};

describe("teamSuspendCohort — every member a single Suspend would take", () => {
  it("takes the live, the rising and nothing that is already down", () => {
    expect(teamSuspendCohort(deck(), "team-1", facts)).toEqual({
      take: ["live", "rising"],
      skip: [
        "stopped", // parked
        "stopped", // suspended
        "stopped", // remote
        "remote", // remote-live
        "stopped", // folder-gone
        "stopped", // no-agent
        // Rising, so a Suspend could take it — but not over the one still
        // taking it down, which the single Suspend refuses as in-flight.
        "in-flight", // reaping
      ],
    });
  });

  it("leaves a member whose team is still creating its directory", () => {
    expect(teamSuspendCohort(deck(), "team-2", facts)).toEqual({
      take: [],
      skip: ["provisioning"], // creating
    });
  });

  it("answers an empty cohort for a team with nobody on it", () => {
    expect(teamSuspendCohort(deck(), "team-9", facts)).toEqual({ take: [], skip: [] });
  });
});

describe("teamResumeCohort — every member down by a decision that a single Resume would ask back", () => {
  it("takes the parked AND the suspended, and says why it leaves each of the rest", () => {
    expect(teamResumeCohort(deck(), "team-1", facts)).toEqual({
      take: ["parked", "suspended"],
      skip: [
        "running", // live
        "waking", // rising
        "remote", // remote
        "running", // remote-live
        "blocked", // folder-gone
        "unavailable", // no-agent
        "waking", // reaping
      ],
    });
  });

  it("leaves a member whose team is still creating its directory", () => {
    expect(teamResumeCohort(deck(), "team-2", facts).skip).toEqual(["provisioning"]);
  });

  it("takes nobody in an archived workspace — restoring it comes first", () => {
    const cohort = teamResumeCohort(deck({ archived: { at: AT, phase: "archived" } }), "team-1", facts);
    expect(cohort.take).toEqual([]);
    expect(cohort.skip.every((why) => why === "archived")).toBe(true);
  });
});

describe("a team act waits for the whole team to settle", () => {
  /** A team of two: one agent up, one suspended — each act would take one. */
  const pair = (location: TeamLocation = { kind: "attached", cwd: "/repo" }): Workspace =>
    deck({
      teams: [{ id: "team-3", name: "three", location }],
      panes: [on("team-3", { id: "up" }), on("team-3", { id: "down", idle: { reason: "suspended", at: AT } })],
    });
  /** The facts with `down` standing where `reach` says, and `up` running. */
  const standing = (reach: AgentReach): TeamActFacts => ({
    ...facts,
    reach: (paneId) => (paneId === "down" ? reach : { kind: "running" }),
  });
  const both = (ws: Workspace, at: TeamActFacts) => {
    const acts = teamActsOf(ws, "team-3", at);
    return { suspend: acts.suspend, resume: acts.resume };
  };
  const waiting = { take: [], skip: ["settling", "settling"] };

  it.each<[string, AgentReach]>([
    ["its stop has not ended", { kind: "down", why: "suspending" }],
    ["it is being taken down", { kind: "down", why: "leaving" }],
    ["it is on its way up", { kind: "starting" }],
  ])("takes nobody while a member is between two states — %s — and leaves every one to wait", (_, reach) => {
    expect(both(pair(), standing(reach))).toEqual({ suspend: waiting, resume: waiting });
  });

  it.each<[string, AgentReach]>([
    ["suspended", { kind: "down", why: "suspended" }],
    ["its process ended", { kind: "down", why: "exited" }],
    ["its workspace is not open", { kind: "down", why: "workspace-closed" }],
  ])("goes on once every member is up or down for good — %s", (_, reach) => {
    expect(both(pair(), standing(reach))).toEqual({
      suspend: { take: ["up"], skip: ["stopped"] },
      resume: { take: ["down"], skip: ["running"] },
    });
  });

  it("lets a team still creating its worktree say so, not that it waits", () => {
    const creating = pair({ kind: "provisioning", intent: { repo: "/repo", path: "/wt/three", index: 3 } });
    const acts = both(creating, standing({ kind: "starting" }));
    expect(acts.suspend.skip).toEqual(["provisioning", "stopped"]);
    expect(acts.resume.skip).toEqual(["provisioning", "provisioning"]);
  });
});

describe("teamActsOf — both cohorts and the machine's gates of that team", () => {
  it("carries the gates the machine named for this team, and none for one it has not", () => {
    expect(teamActsOf(deck(), "team-1", facts).gates).toEqual({ addMember: { kind: "targetLeaving" }, close: null, retry: null });
    expect(teamActsOf(deck(), "team-2", facts).gates).toBeNull();
  });
});

describe("stillTaken — what a confirm counts and its door acts on", () => {
  it("keeps the named members the act still takes, in the act's order", () => {
    expect(stillTaken({ take: ["a", "b", "c"] }, ["c", "a", "x"])).toEqual(["a", "c"]);
  });

  it("never adds one it was not asked about, and drops one it no longer takes", () => {
    expect(stillTaken({ take: ["new"] }, ["a"])).toEqual([]);
    expect(stillTaken({ take: [] }, ["a", "b"])).toEqual([]);
  });
});
