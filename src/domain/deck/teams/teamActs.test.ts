import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Pane } from "../panes";
import type { Workspace } from "../workspaces";
import { teamResumeCohort, teamSuspendCohort, type TeamActFacts } from "./teamActs";

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
    on("team-1", { id: "folder-gone", idle: { reason: "parked" } }),
    on("team-1", { id: "no-agent", agentType: "kimi", idle: { reason: "suspended", at: AT } }),
    on("team-2", { id: "creating" }),
  ],
  ...extra,
});

const facts: TeamActFacts = {
  blocked: (paneId) => paneId === "folder-gone",
  agentAvailable: (agentType) => agentType === "claude",
};

describe("teamSuspendCohort — every member a single Suspend would take", () => {
  it("takes the live, the rising and nothing that is already down", () => {
    expect(teamSuspendCohort(deck(), "team-1", facts)).toEqual({
      take: ["live", "rising"],
      skip: [
        { paneId: "parked", why: "stopped" },
        { paneId: "suspended", why: "stopped" },
        { paneId: "remote", why: "stopped" },
        { paneId: "remote-live", why: "remote" },
        { paneId: "folder-gone", why: "stopped" },
        { paneId: "no-agent", why: "stopped" },
      ],
    });
  });

  it("leaves a member whose team is still creating its directory", () => {
    expect(teamSuspendCohort(deck(), "team-2", facts)).toEqual({
      take: [],
      skip: [{ paneId: "creating", why: "provisioning" }],
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
        { paneId: "live", why: "running" },
        { paneId: "rising", why: "waking" },
        { paneId: "remote", why: "remote" },
        { paneId: "remote-live", why: "running" },
        { paneId: "folder-gone", why: "blocked" },
        { paneId: "no-agent", why: "unavailable" },
      ],
    });
  });

  it("leaves a member whose team is still creating its directory", () => {
    expect(teamResumeCohort(deck(), "team-2", facts).skip).toEqual([{ paneId: "creating", why: "provisioning" }]);
  });

  it("takes nobody in an archived workspace — restoring it comes first", () => {
    const cohort = teamResumeCohort(deck({ archived: { at: AT, phase: "archived" } }), "team-1", facts);
    expect(cohort.take).toEqual([]);
    expect(cohort.skip.every((entry) => entry.why === "archived")).toBe(true);
  });
});
