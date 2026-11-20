import { describe, expect, it } from "vitest";
import { findTeam, findWorkspace, MAX_PANES, TEAM_FULL_MESSAGE } from "../../domain/deck";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import { createDeckActions } from "../deckActions";
import { createDeckStore } from "../deckStore";
import { createDeckCommands } from "./deckCommands";

/** The real deck, its real actions, and the owner over them. */
function rig(toTray = false) {
  const store = createDeckStore();
  const owner = createDeckCommands(store, createDeckActions(store), { suspendedToTray: () => toTray });
  const carry = (cmd: Cmd): Promise<Outcome> => owner.carry({ id: { op: 1, index: 0 }, owner: "deck", cmd });
  const ws = () => findWorkspace(store.getSnapshot().workspaces, "ws-a");
  return { store, carry, ws };
}

const workspace: Cmd = { kind: "addWorkspace", workspace: "ws-a", draft: { name: "app", cwd: "/repo", worktreeBaseDir: null } };
const member = (pane: string, role: string, extra: object = {}) => ({ pane, draft: { agentType: "claude", role, ...extra } });
const team = (members: ReturnType<typeof member>[], id = "team-n", n = 1): Cmd => ({
  kind: "addTeam",
  workspace: "ws-a",
  team: id,
  draft: { name: `api ${n}` },
  place: { kind: "attached", cwd: `/wt/kd-app-${n}`, branch: `kd/app/${n}` },
  members,
});

describe("the deck's owner of lifecycle commands", () => {
  it("adds a workspace from its draft, answers the revision it landed at, and answers a repeat unchanged", async () => {
    const { store, carry, ws } = rig();
    expect(await carry(workspace)).toEqual({ kind: "applied", revision: store.revision() });
    expect(ws()?.name).toBe("app");
    expect(await carry(workspace)).toEqual({ kind: "unchanged", revision: store.revision() });
    expect((await carry({ kind: "addWorkspace", workspace: "ws-b", draft: { name: 3 } })).kind).toBe("rejected");
  });

  it("lands a team with its first members whole, or nothing of it", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    expect((await carry(team([member("pane-1", "lead"), member("pane-2", "reviewer")]))).kind).toBe("applied");
    expect(ws()?.panes.map((pane) => [pane.id, pane.team])).toEqual([
      ["pane-1", { teamId: "team-n", role: "lead" }],
      // A repeatable role is given its number by the role rule.
      ["pane-2", { teamId: "team-n", role: "reviewer-1" }],
    ]);
    expect((await carry(team([member("pane-1", "lead")]))).kind).toBe("unchanged");

    // A shape the role rule refuses: the second lead.
    const refused = await carry(team([member("pane-3", "lead"), member("pane-4", "lead")], "team-m", 2));
    expect(refused).toEqual({ kind: "rejected", reason: expect.stringContaining("lead") });
    const after = ws();
    expect(after && findTeam(after, "team-m")).toBeUndefined();
    expect(after?.panes.map((pane) => pane.id)).toEqual(["pane-1", "pane-2"]);
  });

  it("refuses a member that resumes a conversation another pane holds, writing nothing", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    await carry(team([member("pane-1", "lead", { session: { id: "s-1" } })]));
    const twice = await carry({ kind: "addPane", workspace: "ws-a", team: "team-n", pane: "pane-2", draft: member("pane-2", "reviewer", { session: { id: "s-1" } }).draft });
    expect(twice).toEqual({ kind: "rejected", reason: "That conversation is already open in another agent." });
    expect(ws()?.panes.map((pane) => pane.id)).toEqual(["pane-1"]);
  });

  it("refuses two first members resuming one conversation, writing nothing", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    const both = await carry(team([member("pane-1", "lead", { session: { id: "s-1" } }), member("pane-2", "reviewer", { session: { id: "s-1" } })]));
    expect(both).toEqual({ kind: "rejected", reason: "That conversation is already open in another agent." });
    const after = ws();
    expect(after && findTeam(after, "team-n")).toBeUndefined();
    expect(after?.panes).toEqual([]);
  });

  it("seats the first members a team asked again is missing, and answers unchanged only when none is", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    // A deck that kept the team with only part of its first members.
    await carry(team([member("pane-1", "lead")]));
    const whole = team([member("pane-1", "lead"), member("pane-2", "reviewer")]);
    expect((await carry(whole)).kind).toBe("applied");
    expect(ws()?.panes.map((pane) => [pane.id, pane.team?.teamId])).toEqual([
      ["pane-1", "team-n"],
      ["pane-2", "team-n"],
    ]);
    expect((await carry(whole)).kind).toBe("unchanged");
  });

  it("seats a pane under the role rule, and answers a repeat unchanged", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    await carry(team([member("pane-1", "lead")]));
    const seat: Cmd = { kind: "addPane", workspace: "ws-a", team: "team-n", pane: "pane-2", draft: member("pane-2", "reviewer").draft };
    expect((await carry(seat)).kind).toBe("applied");
    expect((await carry(seat)).kind).toBe("unchanged");
    const taken: Cmd = { kind: "addPane", workspace: "ws-a", team: "team-n", pane: "pane-3", draft: member("pane-3", "lead").draft };
    expect((await carry(taken)).kind).toBe("rejected");
    expect(ws()?.panes.map((pane) => pane.id)).toEqual(["pane-1", "pane-2"]);
  });

  it("moves a member to a root team it mints under the machine's id, its role carried", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    await carry(team([member("pane-1", "lead", { session: { id: "s-1" } }), member("pane-2", "reviewer")]));
    expect((await carry({ kind: "movePane", workspace: "ws-a", pane: "pane-1", to: "team-root", newRoot: true, role: null })).kind).toBe("applied");
    const moved = ws()?.panes.find((pane) => pane.id === "pane-1");
    expect(moved?.team).toEqual({ teamId: "team-root", role: "lead" });
    expect(moved?.session).toBeUndefined();
    const current = ws();
    expect(current && findTeam(current, "team-root")?.location).toEqual({ kind: "attached", cwd: "/repo" });
    expect((await carry({ kind: "movePane", workspace: "ws-a", pane: "pane-1", to: "team-root", newRoot: true, role: null })).kind).toBe("unchanged");
  });

  it("moves a member under the role the person picked on the root team, and refuses one it cannot hold", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    await carry(team([member("pane-1", "lead"), member("pane-2", "reviewer")]));
    expect((await carry({ kind: "movePane", workspace: "ws-a", pane: "pane-2", to: "team-root", newRoot: true, role: "lead" })).kind).toBe("applied");
    expect(ws()?.panes.find((pane) => pane.id === "pane-2")?.team).toEqual({ teamId: "team-root", role: "lead" });
    // The root team has its lead now: a second pick of it is refused, the
    // member left where it was.
    const refused = await carry({ kind: "movePane", workspace: "ws-a", pane: "pane-1", to: "team-root", newRoot: false, role: "lead" });
    expect(refused.kind).toBe("rejected");
    expect(ws()?.panes.find((pane) => pane.id === "pane-1")?.team?.teamId).toBe("team-n");
  });

  it("removes a pane, a team with its members, and a workspace — a repeat finds them gone", async () => {
    const { store, carry, ws } = rig();
    await carry(workspace);
    await carry(team([member("pane-1", "lead"), member("pane-2", "reviewer")]));
    expect((await carry({ kind: "removePane", workspace: "ws-a", pane: "pane-2" })).kind).toBe("applied");
    expect((await carry({ kind: "removePane", workspace: "ws-a", pane: "pane-2" })).kind).toBe("unchanged");
    expect((await carry({ kind: "removeTeam", workspace: "ws-a", team: "team-n" })).kind).toBe("applied");
    const left = ws();
    expect(left?.panes).toEqual([]);
    expect(left && findTeam(left, "team-n")).toBeUndefined();
    expect((await carry({ kind: "removeTeam", workspace: "ws-a", team: "team-n" })).kind).toBe("unchanged");
    expect((await carry({ kind: "removeWorkspace", workspace: "ws-a" })).kind).toBe("applied");
    expect(store.getSnapshot().workspaces).toEqual([]);
  });

  it("settles, fails and retries a team whose worktree is being made", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    await carry({
      kind: "addTeam",
      workspace: "ws-a",
      team: "team-n",
      draft: { name: "api" },
      place: { kind: "provisioning", op: 4, path: "/wt/kd-app-1", branch: "kd/app/1", base: null },
      members: [member("pane-1", "lead")],
    });
    const location = () => {
      const current = ws();
      return current ? findTeam(current, "team-n")?.location : undefined;
    };
    expect(location()).toMatchObject({ kind: "provisioning", intent: { path: "/wt/kd-app-1", branch: "kd/app/1" } });
    await carry({ kind: "failTeam", workspace: "ws-a", team: "team-n", reason: "no space" });
    expect(location()).toMatchObject({ error: "no space" });
    await carry({ kind: "retryTeam", workspace: "ws-a", team: "team-n" });
    expect(location()).not.toHaveProperty("error");
    await carry({ kind: "settleTeam", workspace: "ws-a", team: "team-n", cwd: "/wt/kd-app-1", branch: "kd/app/1" });
    expect(location()).toEqual({ kind: "attached", cwd: "/wt/kd-app-1", branch: "kd/app/1" });
  });

  it("refuses a command that is not the deck's", async () => {
    const { carry } = rig();
    expect((await carry({ kind: "forgetBoards", workspace: "ws-a" })).kind).toBe("rejected");
  });

  it("refuses a seat or a move onto a team at its cap, in the team's own words", async () => {
    const { carry, ws } = rig();
    await carry(workspace);
    await carry(team(Array.from({ length: MAX_PANES }, (_, i) => member(`pane-${i + 1}`, i === 0 ? "lead" : `impl-${i}`))));
    const seat = await carry({ kind: "addPane", workspace: "ws-a", team: "team-n", pane: "pane-99", draft: member("pane-99", "reviewer").draft });
    expect(seat).toEqual({ kind: "rejected", reason: TEAM_FULL_MESSAGE });
    expect(ws()?.panes).toHaveLength(MAX_PANES);
  });

  it("marks a suspended pane, and shelves it in the tray only when that is the person's placement", async () => {
    for (const toTray of [false, true]) {
      const { store, carry } = rig(toTray);
      await carry(workspace);
      await carry(team([member("pane-1", "lead")]));
      expect((await carry({ kind: "markSuspended", workspace: "ws-a", pane: "pane-1" })).kind).toBe("applied");
      const state = store.getSnapshot();
      expect(state.workspaces[0].panes[0].idle).toMatchObject({ reason: "suspended" });
      expect(state.viewByWs["ws-a"]?.suspendedTray ?? []).toEqual(toTray ? ["pane-1"] : []);
    }
  });
});
