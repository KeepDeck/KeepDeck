import { describe, expect, it } from "vitest";
import type { Workspace } from "../deck/workspaces";
import { createWorkspaceInstance } from "../workspaceInstance";
import { deckFactsOf } from "./facts";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "ws-a",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: "/wt",
  panes: [],
  ...over,
});

describe("deckFactsOf", () => {
  it("hands every team where it runs — attached, still being made, or nowhere yet", () => {
    const facts = deckFactsOf([
      ws({
        teams: [
          { id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/a", branch: "kd/web/1" } },
          { id: "team-2", name: "root", location: { kind: "attached", cwd: "/repo" } },
          { id: "team-3", name: "new", location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/b", branch: "kd/web/2", index: 2 } } },
          { id: "team-4", name: "mail" },
        ],
      }),
    ]);
    expect(facts.workspaces[0].teams).toEqual([
      { id: "team-1", at: { kind: "attached", cwd: "/wt/a", branch: "kd/web/1" } },
      { id: "team-2", at: { kind: "attached", cwd: "/repo", branch: null } },
      { id: "team-3", at: { kind: "provisioning", path: "/wt/b", branch: "kd/web/2" } },
      { id: "team-4", at: { kind: "unplaced" } },
    ]);
  });

  it("hands every pane with its team, whether it is remote, and whether it was suspended", () => {
    const facts = deckFactsOf([
      ws({
        panes: [
          { id: "pane-1", agentType: "a", team: { teamId: "team-1", role: "lead" } },
          { id: "pane-2", agentType: "a", location: { kind: "remote", endpoint: "ws://vps" } },
          { id: "pane-3", agentType: "a", idle: { reason: "suspended", at: "t" } },
          { id: "pane-4", agentType: "a", idle: { reason: "parked" } },
        ],
      }),
    ]);
    expect(facts.workspaces[0].panes).toEqual([
      { id: "pane-1", team: "team-1", remote: false, suspended: false },
      { id: "pane-2", team: null, remote: true, suspended: false },
      { id: "pane-3", team: null, remote: false, suspended: true },
      { id: "pane-4", team: null, remote: false, suspended: false },
    ]);
  });

  it("tells an archived workspace from one whose archive was under way, and both from a live one", () => {
    const facts = deckFactsOf([
      ws({ id: "ws-live" }),
      ws({ id: "ws-done", archived: { at: "t", phase: "archived" } }),
      ws({ id: "ws-mid", archived: { at: "t", phase: "archiving" } }),
    ]);
    expect(facts.workspaces.map(({ id, archived, archiving }) => ({ id, archived, archiving }))).toEqual([
      { id: "ws-live", archived: false, archiving: false },
      { id: "ws-done", archived: true, archiving: false },
      { id: "ws-mid", archived: false, archiving: true },
    ]);
    expect(facts.workspaces[0]).toMatchObject({ name: "web", cwd: "/repo", worktreeBase: "/wt" });
  });
});
