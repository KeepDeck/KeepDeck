import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../deck";
import { resolveNamedPanes } from "../deck/teams/testSupport";
import { createWorkspaceInstance } from "../workspaceInstance";
import { paneIsOnTeam, resolveMailTarget, teamMembers, teamNameKey, teamOf } from "./team";

const AGENTS = [{ id: "claude", label: "Claude" }];

/** Membership spoken by name, the way the dialog says it; `workspace`
 * resolves it into the team the pane then holds by id. */
const pane = (id: string, named?: { name: string; role: string }): Pane =>
  ({ id, agentType: "claude", ...(named ? { named } : {}) }) as Pane;

const workspace = (panes: Pane[]): Workspace =>
  resolveNamedPanes({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  } as Workspace);

/** The pane as the workspace holds it — the fixture's object is resolved
 * into a new one, so a test reads it back by id. */
const held = (ws: Workspace, id: string): Pane => ws.panes.find((p) => p.id === id)!;

describe("teamMembers", () => {
  it("collects a team across the workspace, ignoring case", () => {
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "API", role: "impl-1" }),
      pane("pane-3", { name: "web", role: "lead" }),
      pane("pane-4"),
    ]);
    expect(teamMembers(ws, "api").map((p) => p.id)).toEqual(["pane-1", "pane-2"]);
  });
});

describe("teamNameKey", () => {
  it("folds case and surrounding space, and nothing else", () => {
    expect(teamNameKey(" API ")).toBe("api");
    expect(teamNameKey("api")).toBe("api");
    expect(teamNameKey("Api Team")).toBe("api team");
  });
});

describe("paneIsOnTeam", () => {
  it("matches a name however it was cased or padded, on either side", () => {
    // A hand-edited document can hold " API "; the person typing "api"
    // means that team. Both sides go through the one key.
    const ws = workspace([pane("pane-1", { name: " API ", role: "lead" }), pane("pane-2")]);
    const member = held(ws, "pane-1");
    expect(paneIsOnTeam(ws, member, "api")).toBe(true);
    expect(paneIsOnTeam(ws, member, "  Api")).toBe(true);
    expect(paneIsOnTeam(ws, member, "web")).toBe(false);
    expect(paneIsOnTeam(ws, held(ws, "pane-2"), "api")).toBe(false);
  });
});

describe("resolveMailTarget", () => {
  it("lets a role outrank anything else a pane could be called", () => {
    // The whole reason roles exist: an agent told "report to lead" must
    // reach the lead even where some pane is titled "lead", because a title
    // follows the terminal and moves under everyone's feet.
    const decoy = pane("pane-9");
    decoy.name = "lead";
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
      decoy,
    ]);
    const result = resolveMailTarget(ws, AGENTS, held(ws, "pane-2"), "lead");
    expect(result.ok && result.value.id).toBe("pane-1");
  });

  it("falls back to an ordinary pane reference", () => {
    const ws = workspace([pane("pane-2", { name: "api", role: "impl-1" }), pane("pane-3")]);
    expect(resolveMailTarget(ws, AGENTS, held(ws, "pane-2"), "pane-3").ok).toBe(true);
  });

  it("works unchanged where nobody is in a team", () => {
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    const me = held(ws, "pane-1");
    expect(resolveMailTarget(ws, AGENTS, me, "pane-2").ok).toBe(true);
    expect(resolveMailTarget(ws, AGENTS, me, "nobody").ok).toBe(false);
  });

  it("tells a teammate which roles it could have written to", () => {
    // "no agent X" sends an agent hunting for a window title nobody gave
    // it. The roles are what it was actually handed.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    const result = resolveMailTarget(ws, AGENTS, held(ws, "pane-1"), "impl-7");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("impl-1");
      // ...and never suggests writing to itself.
      expect(result.message).not.toContain("lead");
    }
  });
});

describe("teamOf", () => {
  it("reports null rather than dropping the field", () => {
    const ws = workspace([pane("pane-1"), pane("pane-2", { name: "api", role: "lead" })]);
    expect(teamOf(ws, held(ws, "pane-1"))).toBeNull();
    // The id is what a caller hands back to `team.add`; the name is what it
    // says out loud.
    expect(teamOf(ws, held(ws, "pane-2"))).toEqual({
      id: expect.stringMatching(/^team-\d+$/),
      name: "api",
      role: "lead",
    });
  });

  it("reads the NAME off the team, not off the pane", () => {
    // The pane holds an id. A pane whose id names no team the workspace has
    // is on no team to anyone reading it — never a member of nothing.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    const orphan = { ...held(ws, "pane-1"), team: { teamId: "team-404", role: "lead" } };
    expect(teamOf(ws, orphan)).toBeNull();
    expect(teamMembers(ws, "api").map((p) => p.id)).toEqual(["pane-1"]);
  });
});
