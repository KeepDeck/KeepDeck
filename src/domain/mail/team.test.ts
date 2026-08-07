import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../deck";
import { createWorkspaceInstance } from "../workspaceInstance";
import {
  checkTeamAssignment,
  decideTeamSpec,
  formatTeamSpec,
  parseTeamSpec,
  resolveMailTarget,
  teamMembers,
  teamOf,
} from "./team";

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

describe("checkTeamAssignment", () => {
  it("takes a free role and trims what it stores", () => {
    const ws = workspace([pane("pane-1")]);
    expect(checkTeamAssignment(ws, "pane-1", { name: "  api  ", role: " lead " })).toEqual({
      ok: true,
      value: { name: "api", role: "lead" },
    });
  });

  it("refuses a role another pane already answers to", () => {
    // Roles are ADDRESSES. Two panes answering to "impl-1" makes every
    // message to it a coin toss, which is worse than having no role.
    const ws = workspace([pane("pane-1", { name: "api", role: "impl-1" }), pane("pane-2")]);
    const result = checkTeamAssignment(ws, "pane-2", { name: "api", role: "IMPL-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("already taken");
  });

  it("lets the same role live in a different team", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" }), pane("pane-2")]);
    expect(checkTeamAssignment(ws, "pane-2", { name: "web", role: "lead" }).ok).toBe(true);
  });

  it("lets a pane keep its own role when reassigned", () => {
    // Renaming a team, or re-stating the same assignment, must not collide
    // with the pane itself.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    expect(checkTeamAssignment(ws, "pane-1", { name: "api", role: "lead" }).ok).toBe(true);
  });

  it("refuses a blank name or role", () => {
    const ws = workspace([pane("pane-1")]);
    expect(checkTeamAssignment(ws, "pane-1", { name: "  ", role: "lead" }).ok).toBe(false);
    expect(checkTeamAssignment(ws, "pane-1", { name: "api", role: "" }).ok).toBe(false);
  });
});

describe("parseTeamSpec", () => {
  it("reads role@team, trimming both halves", () => {
    expect(parseTeamSpec("  impl-1 @ api  ")).toEqual({ name: "api", role: "impl-1" });
  });

  it("reads blank as leaving the team", () => {
    expect(parseTeamSpec("   ")).toBeNull();
  });

  it("refuses a role with no team rather than guessing one", () => {
    // Guessing which team a pane joins is how a role ends up answering in
    // the wrong conversation.
    expect(parseTeamSpec("impl-1")).toBeNull();
    expect(parseTeamSpec("@api")).toBeNull();
    expect(parseTeamSpec("impl-1@")).toBeNull();
    expect(parseTeamSpec("a@b@c")).toBeNull();
  });

  it("round-trips what it formats", () => {
    expect(formatTeamSpec({ name: "api", role: "lead" })).toBe("lead@api");
    expect(parseTeamSpec(formatTeamSpec({ name: "api", role: "lead" }))).toEqual({
      name: "api",
      role: "lead",
    });
    expect(formatTeamSpec(null)).toBe("");
  });
});

describe("decideTeamSpec", () => {
  it("turns a typed field into the one thing to store", () => {
    const ws = workspace([pane("pane-1")]);
    expect(decideTeamSpec(ws, "pane-1", "lead@api")).toEqual({
      ok: true,
      value: { name: "api", role: "lead" },
    });
  });

  it("reads an emptied field as leaving the team", () => {
    // The same convention a cleared rename follows: blank means "undo the
    // thing I set", not "reject my input".
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    expect(decideTeamSpec(ws, "pane-1", "  ")).toEqual({ ok: true, value: null });
  });

  it("says how to write it when the field is not a role and a team", () => {
    const ws = workspace([pane("pane-1")]);
    const result = decideTeamSpec(ws, "pane-1", "impl-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("role@team");
  });

  it("refuses a role that is already taken, with the same words as the tool path", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" }), pane("pane-2")]);
    const result = decideTeamSpec(ws, "pane-2", "lead@api");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("already taken");
  });
});

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
