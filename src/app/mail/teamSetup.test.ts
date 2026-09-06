import { describe, expect, it, vi } from "vitest";
import {
  initialDeckState,
  paneExecutionCwd,
  type Workspace,
} from "../../domain/deck";
import { planTeam, type TeamPlan } from "../../domain/mail";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createDeckActions } from "../deckActions";
import { createDeckStore } from "../deckStore";
import { applyTeamPlan } from "./teamSetup";

type Spawn = (
  workspaceId: string,
  teamId: string,
  agentType: string,
  yolo: boolean,
  role: string,
) => Promise<string | null>;

function setup(spawn?: Spawn) {
  const calls: string[] = [];
  const reports: string[] = [];
  const told: { paneId: string; body: string }[] = [];
  const deps = {
    announce: (paneId: string, _kind: "team", body: string) =>
      told.push({ paneId, body }),
    settleRoster: (
      _ws: string,
      teamId: string,
      name: string,
      members: readonly { paneId: string; role: string }[],
    ) =>
      calls.push(
        `settle ${teamId} "${name}" ${members.map((m) => `${m.paneId}=${m.role}`).join(",")}`,
      ),
    spawn: spawn ?? (async () => "pane-new"),
    report: (title: string) => reports.push(title),
  };
  return { deps, calls, reports, told };
}

const plan = (over: Partial<TeamPlan> = {}): TeamPlan => ({
  teamId: "team-1",
  name: "api",
  members: [],
  recruits: [],
  ...over,
});

describe("applyTeamPlan", () => {
  it("writes the roster whole, before anything else", async () => {
    // One deck change for the name and every role: a swap never passes
    // through a moment in which one address is held twice, and the recruits
    // that follow find every handed-over address already free.
    const spawn = vi.fn(async () => "pane-9");
    const h = setup(spawn);
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        name: "platform",
        members: [
          { paneId: "pane-1", role: "impl-1" },
          { paneId: "pane-2", role: "lead" },
        ],
        recruits: [{ agentType: "claude", role: "impl-2", yolo: false }],
      }),
    );
    expect(h.calls).toEqual(['settle team-1 "platform" pane-1=impl-1,pane-2=lead']);
    expect(spawn.mock.invocationCallOrder[0]).toBeGreaterThan(0);
  });

  it("starts each recruit ON the team, by id, under its role — the start is the placement", async () => {
    // No second step writes the membership: the recruit lands on the team
    // in the same step that starts it, so there is no moment in which the
    // pane exists on no team.
    const spawn = vi.fn(async () => "pane-9");
    const h = setup(spawn);
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ recruits: [{ agentType: "claude", role: "impl-1", yolo: false }] }),
    );
    expect(spawn).toHaveBeenCalledWith("ws-1", "team-1", "claude", false, "impl-1");
    expect(h.told.map((entry) => entry.paneId)).toEqual(["pane-9"]);
  });

  it("carries each recruit's OWN yolo answer, not the global default", async () => {
    // Asked per row precisely because a lead and an implementer want
    // different answers. Dropping it here would silently ignore what the
    // person just chose.
    const asked: boolean[] = [];
    const h = setup(async (_ws, _team, _agent, yolo) => {
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

  it("keeps the roster that DID settle when a recruit will not start", async () => {
    // Undoing the roster because a fourth agent failed to launch would
    // take away the part that worked.
    const h = setup(async () => {
      throw new Error("the team is full");
    });
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "impl-1", yolo: false }],
      }),
    );
    expect(h.calls).toEqual(['settle team-1 "api" pane-1=lead']);
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
      throw new Error("the team is full");
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

  it("records the roles even with nothing running to tell", async () => {
    // The feature's toggle can be off; membership is still deck state.
    const h = setup();
    const deps = { ...h.deps, announce: undefined };
    await applyTeamPlan(deps, "ws-1", plan({ members: [{ paneId: "pane-1", role: "lead" }] }));
    expect(h.calls).toEqual(['settle team-1 "api" pane-1=lead']);
    expect(h.told).toEqual([]);
  });

  it("reports a refusal that answered with no pane", async () => {
    // A full team answers without throwing; treating that as success would
    // put a role on a pane that does not exist.
    const h = setup(async () => null);
    await applyTeamPlan(
      h.deps,
      "ws-1",
      plan({ recruits: [{ agentType: "claude", role: "impl-1", yolo: false }] }),
    );
    expect(h.told).toEqual([]);
    expect(h.reports).toHaveLength(1);
  });

  it("reports every recruit when the deck cannot start agents here", async () => {
    const h = setup();
    const deps = { ...h.deps, spawn: undefined };
    await applyTeamPlan(
      deps,
      "ws-1",
      plan({ recruits: [{ agentType: "claude", role: "impl-1", yolo: false }] }),
    );
    expect(h.reports).toEqual(['Could not start claude as “impl-1”']);
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
    expect(attempt).toBe(2);
    expect(h.told.map((entry) => entry.paneId)).toEqual(["pane-9"]);
    expect(h.reports).toHaveLength(1);
  });
});

describe("applyTeamPlan against the deck", () => {
  // The scenario the review reproduced: a rename through the roster path
  // minted a second, directory-less team and moved the members onto it —
  // their ids changed and their cwd fell back to the workspace root.
  const api = (): Workspace => ({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: "/wt",
    teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/api", branch: "kd/api" } }],
    panes: [
      { id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
      { id: "p2", agentType: "claude", team: { teamId: "team-1", role: "impl-1" } },
    ],
  });
  const store = () =>
    createDeckStore({ ...initialDeckState, workspaces: [api()], activeId: "ws-1" });

  it("renames api → platform and swaps the roles in place: the ids and the directory stay", async () => {
    const deck = store();
    const before = deck.getSnapshot().workspaces[0];
    const settled = planTeam(
      before,
      {
        name: "platform",
        members: [
          { paneId: "p1", role: "impl-1" },
          { paneId: "p2", role: "lead" },
        ],
        recruits: [],
      },
      "team-1",
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    await applyTeamPlan(
      { settleRoster: createDeckActions(deck).settleRoster, report: () => {} },
      "ws-1",
      settled.value,
    );
    const after = deck.getSnapshot().workspaces[0];
    expect(after.teams).toEqual([
      { id: "team-1", name: "platform", location: { kind: "attached", cwd: "/wt/api", branch: "kd/api" } },
    ]);
    expect(after.panes.map((pane) => pane.team)).toEqual([
      { teamId: "team-1", role: "impl-1" },
      { teamId: "team-1", role: "lead" },
    ]);
    expect(after.panes.map((pane) => paneExecutionCwd(after, pane))).toEqual(["/wt/api", "/wt/api"]);
  });

  it("never makes a team: a plan for a team that is not here is refused, and the deck settles nothing for it", async () => {
    const deck = store();
    const before = deck.getSnapshot();
    const planned = planTeam(
      before.workspaces[0],
      { name: "ghost", members: [], recruits: [] },
      "team-9",
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.message).toContain("team.create");
    // Even a plan forged by hand writes nothing: the deck knows no such team.
    await applyTeamPlan(
      { settleRoster: createDeckActions(deck).settleRoster, report: () => {} },
      "ws-1",
      { teamId: "team-9", name: "ghost", members: [], recruits: [] },
    );
    expect(deck.getSnapshot().workspaces).toBe(before.workspaces);
    expect(deck.getSnapshot().workspaces[0].teams?.every((team) => team.location)).toBe(true);
  });
});
