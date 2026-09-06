import { describe, expect, it, vi } from "vitest";
import type { TeamPlan } from "../../domain/mail";
import { createTeamFlow } from "./teamFlow";

const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  teamId: "team-1",
  name: "api",
  members: [],
  recruits: [],
  ...over,
});

function setup() {
  const calls: string[] = [];
  const flow = createTeamFlow({
    settleRoster: (_ws, teamId, name, members) =>
      calls.push(`settled ${teamId} "${name}" ${members.map((m) => `${m.paneId}=${m.role}`).join(",")}`),
    spawn: async (_ws, teamId, agentType, _yolo, role) => {
      calls.push(`spawned ${agentType} as ${role} on ${teamId}`);
      return "pane-new";
    },
    report: (title) => calls.push(`reported ${title}`),
    announce: (paneId) => calls.push(`told ${paneId}`),
  });
  return { flow, calls };
}

describe("createTeamFlow", () => {
  it("carries a whole plan through: the roster, the recruits, the briefings", async () => {
    const h = setup();
    await h.flow.apply(
      "ws-1",
      plan({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "impl-1", yolo: false }],
      }),
    );
    // The recruit lands on the team — by id — by the start itself; no
    // membership is written after the fact.
    expect(h.calls).toEqual([
      'settled team-1 "api" pane-1=lead',
      "spawned claude as impl-1 on team-1",
      "told pane-1",
      "told pane-new",
    ]);
  });

  it("reports a recruit that would not start, and keeps the rest", async () => {
    // The roster already settled is a working team; undoing it because a
    // fourth agent would not launch would take away what did work.
    const calls: string[] = [];
    const flow = createTeamFlow({
      settleRoster: (_ws, teamId) => calls.push(`settled ${teamId}`),
      spawn: vi.fn().mockRejectedValue(new Error("no room")),
      report: (title, message) => calls.push(`reported ${title}: ${message}`),
      announce: (paneId) => calls.push(`told ${paneId}`),
    });
    await flow.apply(
      "ws-1",
      plan({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "impl-1", yolo: false }],
      }),
    );
    expect(calls).toEqual([
      "settled team-1",
      "reported Could not start claude as “impl-1”: no room",
      "told pane-1",
    ]);
  });
});
