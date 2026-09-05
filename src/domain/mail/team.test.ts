import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../deck";
import { createWorkspaceInstance } from "../workspaceInstance";
import { paneIsOnTeam, resolveMailTarget, teamMembers, teamNameKey, teamOf } from "./team";

const AGENTS = [{ id: "claude", label: "Claude" }];

const pane = (id: string, team?: { name: string; role: string }): Pane =>
  ({ id, agentType: "claude", ...(team ? { team } : {}) }) as Pane;

const workspace = (panes: Pane[]): Workspace =>
  ({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  }) as Workspace;

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
    const member = pane("pane-1", { name: " API ", role: "lead" });
    expect(paneIsOnTeam(member, "api")).toBe(true);
    expect(paneIsOnTeam(member, "  Api")).toBe(true);
    expect(paneIsOnTeam(member, "web")).toBe(false);
    expect(paneIsOnTeam(pane("pane-2"), "api")).toBe(false);
  });
});

describe("resolveMailTarget", () => {
  it("lets a role outrank anything else a pane could be called", () => {
    // The whole reason roles exist: an agent told "report to lead" must
    // reach the lead even where some pane is titled "lead", because a title
    // follows the terminal and moves under everyone's feet.
    const decoy = pane("pane-9");
    decoy.name = "lead";
    const lead = pane("pane-1", { name: "api", role: "lead" });
    const me = pane("pane-2", { name: "api", role: "impl-1" });
    const ws = workspace([lead, me, decoy]);
    const result = resolveMailTarget(ws, AGENTS, me, "lead");
    expect(result.ok && result.value.id).toBe("pane-1");
  });

  it("falls back to an ordinary pane reference", () => {
    const me = pane("pane-2", { name: "api", role: "impl-1" });
    const other = pane("pane-3");
    const ws = workspace([me, other]);
    expect(resolveMailTarget(ws, AGENTS, me, "pane-3").ok).toBe(true);
  });

  it("works unchanged where nobody is in a team", () => {
    const me = pane("pane-1");
    const ws = workspace([me, pane("pane-2")]);
    expect(resolveMailTarget(ws, AGENTS, me, "pane-2").ok).toBe(true);
    expect(resolveMailTarget(ws, AGENTS, me, "nobody").ok).toBe(false);
  });

  it("tells a teammate which roles it could have written to", () => {
    // "no agent X" sends an agent hunting for a window title nobody gave
    // it. The roles are what it was actually handed.
    const me = pane("pane-1", { name: "api", role: "lead" });
    const ws = workspace([me, pane("pane-2", { name: "api", role: "impl-1" })]);
    const result = resolveMailTarget(ws, AGENTS, me, "impl-7");
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
    expect(teamOf(pane("pane-1"))).toBeNull();
    expect(teamOf(pane("pane-1", { name: "api", role: "lead" }))).toEqual({
      name: "api",
      role: "lead",
    });
  });
});
