import { describe, expect, it } from "vitest";
import type { Pane, Workspace } from "../deck";
import { createWorkspaceInstance } from "../workspaceInstance";
import { admitRole, carryRole, carryRoleInto, roleRefusalMessage, rolesOpenTo, rosterProblem } from "./admission";

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

describe("rosterProblem — the one grammar of a team's shape", () => {
  it("accepts an empty team, a lead alone, a led team, and peers alone", () => {
    expect(rosterProblem([])).toBeNull();
    expect(rosterProblem(["lead"])).toBeNull();
    expect(rosterProblem(["lead", "impl-1", "reviewer-1"])).toBeNull();
    expect(rosterProblem(["peer-1", "peer-2"])).toBeNull();
  });

  it("refuses a repeated address, an unknown role, a mixed shape, and working roles with no lead", () => {
    expect(rosterProblem(["lead", "LEAD"])).toContain("share the role");
    expect(rosterProblem(["wizard-1"])).toContain("not a role");
    expect(rosterProblem(["peer-1", "lead"])).toContain("either led or flat");
    expect(rosterProblem(["peer-1", "impl-1"])).toContain("either led or flat");
    expect(rosterProblem(["impl-1"])).toContain("needs one lead");
  });
});

describe("rolesOpenTo — what the next member may be", () => {
  const ids = (held: string[]) => rolesOpenTo(held).map((open) => open.role.id);

  it("offers an empty team a lead or a peer, and nothing a lone member could not be", () => {
    expect(ids([])).toEqual(["lead", "peer"]);
    expect(rolesOpenTo([]).map((open) => open.address)).toEqual(["lead", "peer-1"]);
  });

  it("offers a led team its working roles — never a second lead, never a peer — at the next free address", () => {
    const open = rolesOpenTo(["lead", "impl-1"]);
    expect(open.map((o) => o.role.id)).not.toContain("lead");
    expect(open.map((o) => o.role.id)).not.toContain("peer");
    expect(open.find((o) => o.role.id === "impl")?.address).toBe("impl-2");
  });

  it("offers a flat team only another peer", () => {
    expect(rolesOpenTo(["peer-1"])).toEqual([expect.objectContaining({ address: "peer-2" })]);
  });
});

describe("carryRole — the role a moved member keeps", () => {
  const moving = (role: string | undefined, onTeam: string[]) =>
    carryRole(
      workspace([
        { id: "mover", agentType: "claude", ...(role ? { team: { teamId: "team-9", role } } : {}) },
        ...onTeam.map((held, i) => on(`p${i}`, held)),
      ]),
      "team-1",
      role,
      "mover",
    );

  it("keeps a free address, and takes the next number of the same role when its number is held", () => {
    expect(moving("reviewer-2", ["lead"])).toEqual({ ok: true, role: "reviewer-2" });
    expect(moving("impl-1", ["lead", "impl-1", "impl-2"])).toEqual({ ok: true, role: "impl-3" });
  });

  it("refuses a singleton already held, a shape the team refuses, and a member with no role at all", () => {
    expect(moving("lead", ["lead"])).toEqual({ ok: false, why: "taken", role: "lead" });
    expect(moving("peer-1", ["lead"])).toEqual({ ok: false, why: "misfit", role: "peer-1" });
    expect(moving("impl-1", ["peer-1"])).toEqual({ ok: false, why: "misfit", role: "impl-1" });
    expect(moving(undefined, ["lead"])).toEqual({ ok: false, why: "missing", role: "" });
  });
});

describe("carryRoleInto — a move onto a team the move mints", () => {
  it("carries what can open a team, and refuses a working role with no lead to report to", () => {
    expect(carryRoleInto([], "lead")).toEqual({ ok: true, role: "lead" });
    expect(carryRoleInto([], "peer-2")).toEqual({ ok: true, role: "peer-2" });
    expect(carryRoleInto([], "impl-1")).toEqual({ ok: false, why: "misfit", role: "impl-1" });
  });
});
