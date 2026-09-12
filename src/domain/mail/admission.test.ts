import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../deck";
import { createWorkspaceInstance } from "../workspaceInstance";
import { admitRole, roleRefusalMessage } from "./admission";

const on = (id: string, role: string): Pane => ({
  id,
  agentType: "claude",
  team: { teamId: "team-1", role },
});

const workspace = (panes: Pane[]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
  teams: [{ id: "team-1", name: "api" }],
});

describe("admitRole", () => {
  it("honours a role that was asked for when the catalog knows it and nobody holds it", () => {
    expect(admitRole(workspace([on("pane-1", "lead")]), "team-1", "reviewer-1")).toEqual({
      ok: true,
      role: "reviewer-1",
    });
  });

  it("refuses an asked-for role that is taken — never substitutes one", () => {
    // Compared the way addresses are: " Impl-1 " is impl-1.
    expect(admitRole(workspace([on("pane-1", "impl-1")]), "team-1", " Impl-1 ")).toEqual({
      ok: false,
      why: "taken",
      role: "Impl-1",
    });
  });

  it("refuses a role the catalog does not know", () => {
    expect(admitRole(workspace([]), "team-1", "wizard-1")).toEqual({
      ok: false,
      why: "unknown",
      role: "wizard-1",
    });
  });

  it("suggests a role when none was asked for — blank counts as none", () => {
    const ws = workspace([on("pane-1", "lead")]);
    expect(admitRole(ws, "team-1")).toEqual({ ok: true, role: "impl-1" });
    expect(admitRole(ws, "team-1", "  ")).toEqual({ ok: true, role: "impl-1" });
  });

  it("does not count the moving pane's own role as held", () => {
    // A pane relocating onto the team it already leads keeps its address.
    const ws = workspace([on("pane-1", "lead")]);
    expect(admitRole(ws, "team-1", "lead", "pane-1")).toEqual({ ok: true, role: "lead" });
    expect(admitRole(ws, "team-1", undefined, "pane-1")).toEqual({ ok: true, role: "lead" });
  });

  it("says a refusal the same way whichever door asked", () => {
    expect(roleRefusalMessage("taken", "lead")).toContain("taken");
    expect(roleRefusalMessage("taken", "lead")).toContain("a role is an address");
    expect(roleRefusalMessage("unknown", "wizard")).toContain('"wizard" is not a role this deck knows');
  });
});
