import { describe, expect, it, vi } from "vitest";
import type { TeamPlan } from "../../domain/mail";
import { applyTeamPlan } from "./teamSetup";

function setup(
  spawn?: TeamSetupSpawn,
  close?: (workspaceId: string, paneId: string) => Promise<void>,
) {
  const calls: string[] = [];
  const reports: string[] = [];
  const told: { paneId: string; body: string }[] = [];
  const deps = {
    announce: (paneId: string, _kind: "team", body: string) =>
      told.push({ paneId, body }),
    setPaneTeam: (
      _ws: string,
      paneId: string,
      team: { name: string; role: string } | null,
    ) => calls.push(team ? `${paneId}=${team.role}@${team.name}` : `${paneId}=off`),
    spawn: spawn ?? (async () => "pane-new"),
    close:
      close ??
      (async (_ws: string, paneId: string) => {
        calls.push(`${paneId}=closed`);
      }),
    report: (title: string) => reports.push(title),
  };
  return { deps, calls, reports, told };
}

type TeamSetupSpawn = (
  workspaceId: string,
  agentType: string,
  yolo: boolean,
) => Promise<string | null>;

const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  name: "api",
  members: [],
  released: [],
  closing: [],
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
      plan({ recruits: [{ agentType: "claude", role: "impl-1", yolo: false }] }),
    );
    expect(spawn).toHaveBeenCalledWith("ws-1", "claude", false);
    expect(h.calls).toEqual(["pane-9=impl-1@api"]);
  });

  it("carries each recruit's OWN yolo answer, not the global default", async () => {
    // Asked per row precisely because a lead and an implementer want
    // different answers. Dropping it here would silently ignore what the
    // person just chose.
    const asked: boolean[] = [];
    const h = setup(async (_ws, _agent, yolo) => {
      asked.push(yolo);
      return "pane-9";
    });
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        recruits: [
          { agentType: "claude", role: "lead", yolo: false },
          { agentType: "claude", role: "impl-1", yolo: true },
        ],
      }),
    );
    expect(asked).toEqual([false, true]);
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
        recruits: [{ agentType: "claude", role: "impl-1", yolo: false }],
      }),
    );
    expect(h.calls).toEqual(["pane-1=lead@api"]);
    expect(h.reports).toEqual(['Could not start claude as “impl-1”']);
  });

  it("tells every member its role and who else it can write to", async () => {
    // An agent cannot work this out for itself — nothing about its own
    // process says it has teammates — so it has to be told at the moment
    // it becomes true, or the feature exists and nobody uses it.
    const h = setup();
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        members: [
          { paneId: "pane-1", role: "lead" },
          { paneId: "pane-2", role: "impl-1" },
        ],
      }),
    );
    expect(h.told.map((t) => t.paneId)).toEqual(["pane-1", "pane-2"]);
    expect(h.told[0].body).toContain('as "lead"');
    expect(h.told[0].body).toContain("impl-1");
    // "KeepDeck team", never a bare "team": asked what its team was, a
    // briefed agent answered about its own subagents instead, because the
    // word already means those to it.
    expect(h.told[0].body).toContain("KeepDeck team");
    expect(h.told[0].body).toContain("not your subagents");
    // ...and never names itself among the teammates it can write to.
    expect(h.told[0].body).not.toMatch(/by role:[^\n]*lead/);
    expect(h.told[1].body).toContain('as "impl-1"');
    expect(h.told[1].body).toContain("lead");
  });

  it("names only teammates that actually landed", async () => {
    // A briefing naming an agent whose spawn failed would send someone
    // writing into nothing.
    const h = setup(async () => {
      throw new Error("workspace is full");
    });
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "impl-1", yolo: false }],
      }),
    );
    expect(h.told).toHaveLength(1);
    expect(h.told[0].body).not.toContain("impl-1");
    expect(h.told[0].body).toContain("only member");
  });

  it("tells whoever left, so it stops writing to roles that reach nobody", async () => {
    const h = setup();
    await applyTeamPlan(h.deps, "ws-1", plan({ released: ["pane-9"] }));
    expect(h.told).toEqual([
      {
        paneId: "pane-9",
        body: expect.stringContaining("no longer on the KeepDeck team"),
      },
    ]);
  });

  it("records the roles even with nothing running to tell", async () => {
    // The feature's toggle can be off; membership is still deck state.
    const h = setup();
    const deps = { ...h.deps, announce: undefined };
    await applyTeamPlan(deps, "ws-1", plan({ members: [{ paneId: "pane-1", role: "lead" }] }));
    expect(h.calls).toEqual(["pane-1=lead@api"]);
    expect(h.told).toEqual([]);
  });

  it("reports a refusal that answered with no pane", async () => {
    // A full workspace answers without throwing; treating that as success
    // would put a role on a pane that does not exist.
    const h = setup(async () => null);
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ recruits: [{ agentType: "claude", role: "impl-1", yolo: false }] }),
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
          { agentType: "claude", role: "impl-1", yolo: false },
          { agentType: "codex", role: "impl-2", yolo: false },
        ],
      }),
    );
    expect(h.calls).toEqual(["pane-9=impl-2@api"]);
    expect(h.reports).toHaveLength(1);
  });

  it("closes LAST, after every pane is off the team", async () => {
    // A close that fails then leaves an agent that is merely off the team,
    // which is the disband the person asked for either way. Closing first
    // would leave a failed close holding a role on a team that no longer
    // exists.
    const h = setup();
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ released: ["pane-1", "pane-2"], closing: ["pane-1", "pane-2"] }),
    );
    expect(h.calls).toEqual([
      "pane-1=off",
      "pane-2=off",
      "pane-1=closed",
      "pane-2=closed",
    ]);
  });

  it("says no goodbye to an agent it is about to close", async () => {
    // A farewell exists so a member stops writing to roles that no longer
    // reach anyone. One being closed has nothing left to stop doing, and
    // the message would cost it a turn it does not have.
    const h = setup();
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ released: ["pane-1", "pane-2"], closing: ["pane-2"] }),
    );
    expect(h.told.map((t) => t.paneId)).toEqual(["pane-1"]);
  });

  it("keeps closing after one refuses, and reports the one that did", async () => {
    // The person asked to end three agents. The two that ended must not be
    // undone by the third, and the failure must not be silent either.
    const h = setup(undefined, async (_ws, paneId) => {
      if (paneId === "pane-2") throw new Error("busy");
      h.calls.push(`${paneId}=closed`);
    });
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ closing: ["pane-1", "pane-2", "pane-3"] }),
    );
    expect(h.calls).toEqual(["pane-1=closed", "pane-3=closed"]);
    expect(h.reports).toEqual(["Could not close an agent"]);
  });

  it("closes nobody for an ordinary edit", async () => {
    // Dropping one member from the roster is organisational and reversible.
    // Naming the panes to close, rather than flagging the released ones, is
    // what keeps it that way.
    const h = setup();
    await applyTeamPlan(h.deps, "ws-1", plan({ released: ["pane-1"] }));
    expect(h.calls).toEqual(["pane-1=off"]);
  });
});
