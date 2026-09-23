import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { roleChoiceView } from "./roleChoiceView";
import { startFreshPick, startFreshRoles } from "./startFreshView";

const pane = (id: string, teamId: string, role?: string): Pane => ({
  id,
  agentType: "claude",
  ...(role ? { team: { teamId, role } } : {}),
});

/** A pane blocked on a lost worktree team, and — when `rootRoles` is given
 * — a team on the workspace root holding those roles. */
const deck = (role: string | undefined, rootRoles?: string[]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws",
  cwd: "/repo",
  worktreeBaseDir: null,
  teams: [
    { id: "team-lost", name: "lost", location: { kind: "attached", cwd: "/repo/wt-gone" } },
    ...(rootRoles ? [{ id: "team-root", name: "root", location: { kind: "attached" as const, cwd: "/repo" } }] : []),
  ],
  panes: [pane("mover", "team-lost", role), ...(rootRoles ?? []).map((r, i) => pane(`r${i}`, "team-root", r))],
});

const rolesFor = (ws: Workspace) => startFreshRoles([ws], ws, ws.panes[0]);
const offered = (ws: Workspace) => rolesFor(ws)!.optionsFor("x").map((option) => option.value);

describe("startFreshRoles — what the folder-gone card asks before the move", () => {
  it("asks nothing when the pane's role carries — renumbered, if only its number is held", () => {
    expect(rolesFor(deck("impl-1", ["lead", "impl-1"]))).toBeNull();
    expect(rolesFor(deck("lead"))).toBeNull();
  });

  it("offers the root team's open roles when the pane's cannot come along", () => {
    expect(offered(deck("lead", ["lead"]))).not.toContain("lead");
    expect(offered(deck("peer-1", ["lead"]))).not.toContain("peer");
  });

  it("offers a team the move would mint a lead or a peer — a working role alone is no team", () => {
    expect(offered(deck("impl-1"))).toEqual(["lead", "peer"]);
    expect(offered(deck(undefined))).toEqual(["lead", "peer"]);
  });
});

describe("startFreshPick — when Start fresh may be pressed", () => {
  it("at once when nothing is asked, else once a role is picked, under its address", () => {
    expect(startFreshPick(null, "")).toEqual({ ready: true, role: undefined });
    const roles = roleChoiceView(["lead"]);
    expect(startFreshPick(roles, "")).toEqual({ ready: false, role: undefined });
    expect(startFreshPick(roles, "impl")).toEqual({ ready: true, role: "impl-1" });
  });
});
