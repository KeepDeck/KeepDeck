import { describe, expect, it, vi } from "vitest";
import type { TeamPlan } from "../../domain/mail";
import { createTeamFlow } from "./teamFlow";

const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  name: "api",
  members: [],
  released: [],
  recruits: [],
  ...over,
});

function setup() {
  const calls: string[] = [];
  const flow = createTeamFlow({
    setPaneTeam: (_ws, paneId, team) =>
      calls.push(`${paneId}=${team ? team.role : "off"}`),
    spawn: async (_ws, agentType) => {
      calls.push(`spawned ${agentType}`);
      return "pane-new";
    },
    close: async (_ws, paneId) => void calls.push(`${paneId}=closed`),
    report: (title) => calls.push(`reported ${title}`),
    announce: (paneId) => calls.push(`told ${paneId}`),
  });
  return { flow, calls };
}

describe("createTeamFlow", () => {
  it("carries a whole plan through: roles, recruits, briefings", async () => {
    const h = setup();
    await h.flow.apply(
      "ws-1",
      plan({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "impl-1", yolo: false }],
      }),
    );
    expect(h.calls).toEqual([
      "pane-1=lead",
      "spawned claude",
      "pane-new=impl-1",
      "told pane-1",
      "told pane-new",
    ]);
  });

  it("ends only what the caller named, never what the plan holds", async () => {
    // Ending an agent is a second thing the person asked for, so it arrives
    // beside the plan. A plan has no field to put one in — which is what
    // stops an ordinary edit ever carrying a close.
    const h = setup();
    await h.flow.apply("ws-1", plan({ released: ["pane-1", "pane-2"] }));
    expect(h.calls.filter((call) => call.endsWith("closed"))).toEqual([]);

    const withClose = setup();
    await withClose.flow.apply("ws-1", plan({ released: ["pane-1"] }), [
      "pane-1",
    ]);
    expect(withClose.calls).toEqual(["pane-1=off", "pane-1=closed"]);
  });

  it("reports a recruit that would not start, and keeps the rest", async () => {
    // The members already placed are a working team; undoing them because a
    // fourth agent would not launch would take away what did work.
    const calls: string[] = [];
    const flow = createTeamFlow({
      setPaneTeam: (_ws, paneId, team) =>
        calls.push(`${paneId}=${team ? team.role : "off"}`),
      spawn: vi.fn().mockRejectedValue(new Error("no room")),
      close: async () => {},
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
      "pane-1=lead",
      "reported Could not start claude as “impl-1”: no room",
      // Briefed about the team that actually landed — naming a teammate
      // whose agent never started would send it writing into nothing.
      "told pane-1",
    ]);
  });
});
