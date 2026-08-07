import { describe, expect, it, vi } from "vitest";
import type { TeamPlan } from "../../domain/mail";
import { applyTeamPlan } from "./teamSetup";

function setup(spawn?: TeamSetupSpawn) {
  const calls: string[] = [];
  const reports: string[] = [];
  const deps = {
    setPaneTeam: (
      _ws: string,
      paneId: string,
      team: { name: string; role: string } | null,
    ) => calls.push(team ? `${paneId}=${team.role}@${team.name}` : `${paneId}=off`),
    spawn: spawn ?? (async () => "pane-new"),
    report: (title: string) => reports.push(title),
  };
  return { deps, calls, reports };
}

type TeamSetupSpawn = (workspaceId: string, agentType: string) => Promise<string | null>;

const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  name: "api",
  members: [],
  released: [],
  recruits: [],
  ...over,
});

describe("applyTeamPlan", () => {
  it("releases before it places, so a handed-over role is free when taken", () => {
    // pane-1 gives up `lead` and pane-2 takes it. Placing first would mean
    // two panes hold one address for the width of a dispatch.
    const h = setup();
    return applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ released: ["pane-1"], members: [{ paneId: "pane-2", role: "lead" }] }),
    ).then(() => {
      expect(h.calls).toEqual(["pane-1=off", "pane-2=lead@api"]);
    });
  });

  it("starts each recruit and puts it straight on the team", async () => {
    const spawn = vi.fn(async () => "pane-9");
    const h = setup(spawn);
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ recruits: [{ agentType: "claude", role: "impl-1" }] }),
    );
    expect(spawn).toHaveBeenCalledWith("ws-1", "claude");
    expect(h.calls).toEqual(["pane-9=impl-1@api"]);
  });

  it("keeps the team that DID form when a recruit will not start", async () => {
    // Undoing the members because a fourth agent failed to launch would
    // take away the part that worked.
    const h = setup(async () => {
      throw new Error("workspace is full");
    });
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "impl-1" }],
      }),
    );
    expect(h.calls).toEqual(["pane-1=lead@api"]);
    expect(h.reports).toEqual(['Could not start claude as “impl-1”']);
  });

  it("reports a refusal that answered with no pane", async () => {
    // A full workspace answers without throwing; treating that as success
    // would put a role on a pane that does not exist.
    const h = setup(async () => null);
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ recruits: [{ agentType: "claude", role: "impl-1" }] }),
    );
    expect(h.calls).toEqual([]);
    expect(h.reports).toHaveLength(1);
  });

  it("carries on to the next recruit after one fails", async () => {
    let attempt = 0;
    const h = setup(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("no");
      return "pane-9";
    });
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        recruits: [
          { agentType: "claude", role: "impl-1" },
          { agentType: "codex", role: "impl-2" },
        ],
      }),
    );
    expect(h.calls).toEqual(["pane-9=impl-2@api"]);
    expect(h.reports).toHaveLength(1);
  });
});
