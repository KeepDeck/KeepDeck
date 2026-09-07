import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import { MAX_PANES } from "../layout";
import type { Pane } from "../panes/model";
import type { Workspace } from "../workspaces";
import { findTeam, membersOf } from "./collection";
import {
  birthRefusal,
  claimDirectory,
  createTeam,
  directoriesStillHeld,
  dissolveTeam,
  joinTeam,
  renameTeam,
  resolveTeamProvisioning,
  roleTaken,
  setTeamProvisioningError,
  settleRoster,
  teamHeldPath,
  teamNameTaken,
  teamOccupyingPath,
} from "./lifecycle";
import type { Team, TeamLocation } from "./model";

const pane = (id: string): Pane => ({ id, agentType: "claude" });

describe("settleRoster", () => {
  const api: Team = { id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/api" } };
  const web: Team = { id: "team-2", name: "web", location: { kind: "attached", cwd: "/wt/web" } };
  const on = (id: string, teamId: string, role: string): Pane => ({
    id,
    agentType: "claude",
    team: { teamId, role },
  });
  const deck = (): Workspace[] => [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws-1",
      cwd: "/ws-1",
      worktreeBaseDir: null,
      teams: [api, web],
      panes: [on("p1", "team-1", "lead"), on("p2", "team-1", "impl-1"), on("p3", "team-2", "lead")],
    },
  ];
  const rolesOf = (list: Workspace[]) => list[0].panes.map((p) => `${p.id}=${p.team?.role}`);

  it("writes the name and every role in one step — a swap never holds one address twice", () => {
    // p1 and p2 trade addresses. Done a pane at a time, either order passes
    // through a moment with two `lead`s or two `impl-1`s — the state every
    // roster rule exists to make unreachable.
    const next = settleRoster(deck(), "ws-1", "team-1", "platform", [
      { paneId: "p1", role: "impl-1" },
      { paneId: "p2", role: "lead" },
    ]);
    expect(findTeam(next[0], "team-1")).toEqual({ ...api, name: "platform" });
    expect(rolesOf(next)).toEqual(["p1=impl-1", "p2=lead", "p3=lead"]);
    // The ids and the directory are exactly what they were: a rename and a
    // re-role move nobody anywhere.
    expect(next[0].panes.map((p) => p.team?.teamId)).toEqual(["team-1", "team-1", "team-2"]);
    expect(findTeam(next[0], "team-1")?.location).toBe(api.location);
  });

  it("renames without touching the panes, and re-roles without touching the name", () => {
    const start = deck();
    const renamed = settleRoster(start, "ws-1", "team-1", "  platform ", [
      { paneId: "p1", role: "lead" },
      { paneId: "p2", role: "impl-1" },
    ]);
    expect(findTeam(renamed[0], "team-1")?.name).toBe("platform");
    expect(renamed[0].panes[0]).toBe(start[0].panes[0]);
    expect(renamed[0].panes[1]).toBe(start[0].panes[1]);

    const reroled = settleRoster(start, "ws-1", "team-1", "api", [
      { paneId: "p1", role: "lead" },
      { paneId: "p2", role: "impl-2" },
    ]);
    expect(findTeam(reroled[0], "team-1")).toBe(api);
    expect(rolesOf(reroled)).toEqual(["p1=lead", "p2=impl-2", "p3=lead"]);
  });

  it("refuses, with the same array, anything that is not a roster edit of this team", () => {
    const start = deck();
    const both = [
      { paneId: "p1", role: "lead" },
      { paneId: "p2", role: "impl-1" },
    ];
    const refused: [string, Workspace[]][] = [
      ["gone team", settleRoster(start, "ws-1", "team-9", "api", [])],
      ["blank name", settleRoster(start, "ws-1", "team-1", "  ", both)],
      ["another team's name", settleRoster(start, "ws-1", "team-1", " WEB ", both)],
      ["a member left out", settleRoster(start, "ws-1", "team-1", "api", [both[0]])],
      [
        "another team's pane",
        settleRoster(start, "ws-1", "team-1", "api", [both[0], { paneId: "p3", role: "impl-1" }]),
      ],
      [
        "a pane that is not here",
        settleRoster(start, "ws-1", "team-1", "api", [both[0], { paneId: "p9", role: "impl-1" }]),
      ],
      [
        "a pane listed twice",
        settleRoster(start, "ws-1", "team-1", "api", [both[0], { paneId: "p1", role: "impl-1" }]),
      ],
      ["a blank role", settleRoster(start, "ws-1", "team-1", "api", [both[0], { paneId: "p2", role: " " }])],
      [
        "a duplicate role, however cased",
        settleRoster(start, "ws-1", "team-1", "api", [both[0], { paneId: "p2", role: "LEAD" }]),
      ],
    ];
    for (const [why, result] of refused) expect(result, why).toBe(start);
  });

  it("answers the same array when nothing changes", () => {
    const start = deck();
    expect(
      settleRoster(start, "ws-1", "team-1", "api", [
        { paneId: "p1", role: "lead" },
        { paneId: "p2", role: "impl-1" },
      ]),
    ).toBe(start);
  });
});

const workspace = (id: string, panes: Pane[], teams?: Team[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: `/${id}`,
  worktreeBaseDir: null,
  panes,
  ...(teams && { teams }),
});

const attached = (cwd: string): TeamLocation => ({ kind: "attached", cwd });
const creating = (path: string): TeamLocation => ({
  kind: "provisioning",
  intent: { repo: "/ws-1", path, index: 1 },
});

describe("TeamLocation", () => {
  it("names a directory or a create — never the root, never a remote", () => {
    // A team runs somewhere; the root is a directory like any other it can
    // be attached to, and a remote endpoint is the pane's own affair.
    const ok: TeamLocation[] = [attached("/wt/1"), creating("/wt/2")];
    expect(ok).toHaveLength(2);
    // @ts-expect-error — a team is never "main": the root is an attached directory
    const main: TeamLocation = { kind: "main" };
    // @ts-expect-error — a team has no remote endpoint of its own
    const remote: TeamLocation = { kind: "remote", endpoint: "x" };
    expect([main, remote]).toHaveLength(2);
  });
});

describe("createTeam", () => {
  const spec = (over: Partial<Team> = {}): Team & { location: TeamLocation } => ({
    id: "team-1",
    name: "api",
    location: attached("/wt/1"),
    ...over,
  });

  it("adds a team that owns a directory", () => {
    const next = createTeam([workspace("ws-1", [])], "ws-1", spec());
    expect(next[0].teams).toEqual([spec()]);
  });

  it("can attach a team to the workspace root — it is a directory like any other", () => {
    const next = createTeam([workspace("ws-1", [])], "ws-1", spec({ location: attached("/ws-1") }));
    expect(teamHeldPath(next[0].teams![0])).toBe("/ws-1");
  });

  it("refuses a name some team holds, a blank name, a used id and an unasked-for directory", () => {
    const base = createTeam([workspace("ws-1", [])], "ws-1", spec());
    expect(createTeam(base, "ws-1", spec({ id: "team-2", name: " API " }))).toBe(base);
    expect(createTeam(base, "ws-1", spec({ id: "team-2", name: "  " }))).toBe(base);
    expect(createTeam(base, "ws-1", spec({ name: "web" }))).toBe(base);
    // A directory a team works in: refused UNTIL the caller says it means it.
    expect(
      createTeam(base, "ws-1", spec({ id: "team-2", name: "web", location: attached("/wt/1/") })),
    ).toBe(base);
    // A directory a create is HEADING for is refused whatever the caller says.
    expect(
      createTeam(base, "ws-1", spec({ id: "team-2", name: "web", location: creating("/wt/1") })),
    ).toBe(base);
    expect(
      createTeam(
        base,
        "ws-1",
        spec({ id: "team-2", name: "web", location: creating("/wt/1") }),
        { shared: true },
      ),
    ).toBe(base);
    expect(teamNameTaken(base[0], "Api")).toBe(true);
    expect(teamNameTaken(base[0], "Api", "team-1")).toBe(false);
  });

  it("takes a second team into a directory the caller asked to share", () => {
    const base = createTeam([workspace("ws-1", [])], "ws-1", spec());
    const shared = createTeam(
      base,
      "ws-1",
      spec({ id: "team-2", name: "web", location: attached("/wt/1/") }),
      { shared: true },
    );
    expect(shared[0].teams?.map((team) => team.id)).toEqual(["team-1", "team-2"]);
    // Both work in the one directory, spelled as each asked for it.
    expect(shared[0].teams?.map((team) => teamHeldPath(team))).toEqual(["/wt/1", "/wt/1/"]);
  });

  it("never shares a directory a create is still heading for — on either side of the question", () => {
    const heading = createTeam([workspace("ws-1", [])], "ws-1", spec({ location: creating("/wt/1") }));
    expect(
      createTeam(heading, "ws-1", spec({ id: "team-2", name: "web", location: attached("/wt/1") }), {
        shared: true,
      }),
    ).toBe(heading);
  });

  it("asks the same of another workspace's directory — refused unasked, taken when meant", () => {
    const base = createTeam([workspace("ws-1", []), workspace("ws-2", [])], "ws-1", spec());
    expect(teamOccupyingPath(base, "/wt/1")?.team.id).toBe("team-1");
    expect(createTeam(base, "ws-2", spec({ id: "team-2" }))).toBe(base);
    const shared = createTeam(base, "ws-2", spec({ id: "team-2" }), { shared: true });
    expect(shared[1].teams?.map((team) => team.id)).toEqual(["team-2"]);
  });

  it("lets every workspace on one repository hold its own root, and asks before a second root team", () => {
    // The root is the one directory two workspaces legitimately share: a
    // team on it in ws-1 does not hold it for ws-2, so ws-2 is never asked.
    // A SECOND team on it in the SAME workspace is asked for like any other
    // shared directory.
    const shared: Workspace[] = [
      { ...workspace("ws-1", []), cwd: "/repo" },
      { ...workspace("ws-2", []), cwd: "/repo" },
    ];
    const first = createTeam(shared, "ws-1", spec({ location: attached("/repo") }));
    expect(first).not.toBe(shared);
    const second = createTeam(first, "ws-2", spec({ id: "team-2", location: attached("/repo") }));
    expect(second[1].teams?.map((team) => team.id)).toEqual(["team-2"]);
    const third = spec({ id: "team-3", name: "again", location: attached("/repo") });
    expect(createTeam(second, "ws-1", third)).toBe(second);
    expect(
      createTeam(second, "ws-1", third, { shared: true })[0].teams?.map((team) => team.id),
    ).toEqual(["team-1", "team-3"]);
  });
});

describe("claimDirectory", () => {
  const ws = (id: string, cwd: string, teams: Team[]): Workspace => ({
    ...workspace(id, []),
    cwd,
    teams,
  });
  const team = (id: string, location: TeamLocation): Team => ({ id, name: id, location });

  it("calls a directory nobody is in free — and one with no path at all", () => {
    const one = ws("ws-1", "/repo", []);
    expect(claimDirectory([one], one, attached("/wt/1")).kind).toBe("free");
    expect(claimDirectory([one], one, attached("   ")).kind).toBe("free");
  });

  it("names who is in a directory a team WORKS in, and says their create is done", () => {
    const one = ws("ws-1", "/repo", [team("team-1", attached("/wt/1"))]);
    expect(claimDirectory([one], one, attached("/wt/1/"))).toMatchObject({
      kind: "held",
      team: { id: "team-1" },
      creating: false,
    });
  });

  it("reports a create still OUT as the fact it is — the policy is the caller's", () => {
    const heading = ws("ws-1", "/repo", [team("team-1", creating("/wt/1"))]);
    expect(claimDirectory([heading], heading, attached("/wt/1"))).toMatchObject({
      kind: "held",
      creating: true,
    });
    // A create that FAILED is not one still running: its card waits for Retry.
    const failed = ws("ws-1", "/repo", [
      {
        id: "team-1",
        name: "team-1",
        location: { kind: "provisioning", intent: { repo: "/repo", path: "/wt/1", index: 1 }, error: "boom" },
      },
    ]);
    expect(claimDirectory([failed], failed, attached("/wt/1"))).toMatchObject({
      creating: false,
    });
  });

  it("reports the directory's create, not the first team's, whatever order they sit in", () => {
    const both = ws("ws-1", "/repo", [
      team("team-1", attached("/wt/1")),
      team("team-2", creating("/wt/1")),
    ]);
    expect(claimDirectory([both], both, attached("/wt/1"))).toMatchObject({
      kind: "held",
      // The team a pane would JOIN is the first one …
      team: { id: "team-1" },
      // … and the directory still has a create out.
      creating: true,
    });
  });

  it("reaches across workspaces, and names the workspace the holder is in", () => {
    const here = ws("ws-1", "/repo-a", []);
    const there = ws("ws-2", "/repo-b", [team("team-1", attached("/wt/1"))]);
    expect(claimDirectory([here, there], here, attached("/wt/1"))).toMatchObject({
      kind: "held",
      ws: { id: "ws-2" },
      team: { id: "team-1" },
    });
  });

  it("keeps the root exception: a team on another workspace's root is no claim here", () => {
    const here = ws("ws-1", "/repo", []);
    const there = ws("ws-2", "/repo", [team("team-1", attached("/repo"))]);
    expect(claimDirectory([here, there], here, attached("/repo")).kind).toBe("free");
    // The same root in the SAME workspace is a claim like any other.
    const taken = ws("ws-1", "/repo", [team("team-1", attached("/repo"))]);
    expect(claimDirectory([taken, there], taken, attached("/repo")).kind).toBe("held");
  });

  it("birthRefusal turns the fact into the birth policy — and nothing else does", () => {
    const one = ws("ws-1", "/repo", [team("team-1", attached("/wt/1"))]);
    const held = claimDirectory([one], one, attached("/wt/1"));
    expect(birthRefusal(held, attached("/wt/1"), false)).toBe("unshared");
    expect(birthRefusal(held, attached("/wt/1"), true)).toBeNull();
    // A create of our own onto it: git makes no second worktree on one path.
    expect(birthRefusal(held, creating("/wt/1"), true)).toBe("busy");
    expect(birthRefusal({ kind: "free" }, attached("/wt/1"), false)).toBeNull();
  });
});

describe("directoriesStillHeld", () => {
  const team = (id: string, cwd: string): Team => ({ id, name: id, location: attached(cwd) });

  it("keeps a directory a surviving team shares, and lets go of one nobody is left in", () => {
    const one: Workspace = {
      ...workspace("ws-1", []),
      teams: [team("team-1", "/wt/1"), team("team-2", "/wt/1"), team("team-3", "/wt/3")],
    };
    const kept = directoriesStillHeld([one], "ws-1", ["team-1", "team-3"]);
    // team-2 still works in /wt/1; nobody is left in /wt/3.
    expect([...kept]).toEqual(["/wt/1"]);
  });

  it("counts teams in other workspaces — sharing crosses them", () => {
    const here: Workspace = { ...workspace("ws-1", []), teams: [team("team-1", "/wt/1")] };
    const there: Workspace = { ...workspace("ws-2", []), teams: [team("team-1", "/wt/1")] };
    // The same id elsewhere is a DIFFERENT team, and it keeps the directory.
    expect([...directoriesStillHeld([here, there], "ws-1", ["team-1"])]).toEqual(["/wt/1"]);
    expect([...directoriesStillHeld([here], "ws-1", ["team-1"])]).toEqual([]);
  });
});

describe("provisioning on the team", () => {
  const card = () =>
    createTeam([workspace("ws-1", [])], "ws-1", {
      id: "team-1",
      name: "api",
      location: creating("/wt/1"),
    });

  it("resolves a create into the directory it landed at", () => {
    const next = resolveTeamProvisioning(card(), "ws-1", "team-1", { cwd: "/wt/1", branch: "b" });
    expect(findTeam(next[0], "team-1")?.location).toEqual({ kind: "attached", cwd: "/wt/1", branch: "b" });
    expect(resolveTeamProvisioning(next, "ws-1", "team-1", { cwd: "/x", branch: "y" })).toBe(next);
  });

  it("records and clears the failure, keeping the intent for Retry", () => {
    const failed = setTeamProvisioningError(card(), "ws-1", "team-1", "boom");
    const location = findTeam(failed[0], "team-1")!.location!;
    expect(location.kind === "provisioning" && location.error).toBe("boom");
    expect(setTeamProvisioningError(failed, "ws-1", "team-1", "boom")).toBe(failed);
    const retried = setTeamProvisioningError(failed, "ws-1", "team-1", null);
    expect(findTeam(retried[0], "team-1")!.location).toEqual(creating("/wt/1"));
  });
});

describe("renameTeam", () => {
  const base = () =>
    createTeam([workspace("ws-1", [pane("pane-1")])], "ws-1", {
      id: "team-3",
      name: "api",
      location: attached("/wt/3"),
    });

  it("renames the team and leaves the panes alone", () => {
    const on = joinTeam(base(), "ws-1", "pane-1", "team-3", "lead");
    const renamed = renameTeam(on, "ws-1", "team-3", "platform");
    expect(findTeam(renamed[0], "team-3")?.name).toBe("platform");
    expect(renamed[0].panes[0]).toBe(on[0].panes[0]);
  });

  it("reverts an empty name to the auto name, and refuses a taken one", () => {
    let list = createTeam(base(), "ws-1", { id: "team-4", name: "web", location: attached("/wt/4") });
    expect(findTeam(renameTeam(list, "ws-1", "team-3", "  ")[0], "team-3")?.name).toBe("Team 3");
    expect(renameTeam(list, "ws-1", "team-3", "WEB")).toBe(list);
    // Re-spelling its own name is a rename, not a collision.
    list = renameTeam(list, "ws-1", "team-3", "API");
    expect(findTeam(list[0], "team-3")?.name).toBe("API");
  });
});

describe("joinTeam", () => {
  const base = () =>
    createTeam([workspace("ws-1", [pane("pane-1"), pane("pane-2")])], "ws-1", {
      id: "team-1",
      name: "api",
      location: attached("/wt/1"),
    });

  it("puts a pane on the team under a free role", () => {
    const on = joinTeam(base(), "ws-1", "pane-1", "team-1", "lead");
    expect(on[0].panes[0].team).toEqual({ teamId: "team-1", role: "lead" });
    expect(roleTaken(on[0], "team-1", "LEAD")).toBe(true);
    expect(roleTaken(on[0], "team-1", "lead", "pane-1")).toBe(false);
  });

  it("refuses a role somebody else holds, a blank role and a gone team", () => {
    const on = joinTeam(base(), "ws-1", "pane-1", "team-1", "lead");
    expect(joinTeam(on, "ws-1", "pane-2", "team-1", "Lead")).toBe(on);
    expect(joinTeam(on, "ws-1", "pane-2", "team-1", " ")).toBe(on);
    expect(joinTeam(on, "ws-1", "pane-2", "team-9", "impl-1")).toBe(on);
    // Changing its own role is not a collision with itself.
    expect(joinTeam(on, "ws-1", "pane-1", "team-1", "impl-1")[0].panes[0].team?.role).toBe("impl-1");
  });

  it("caps a team at MAX_PANES — the grid its panes lay out on", () => {
    const many = Array.from({ length: MAX_PANES + 1 }, (_, i) => pane(`pane-${i + 1}`));
    let list = createTeam([workspace("ws-1", many)], "ws-1", {
      id: "team-1",
      name: "api",
      location: attached("/wt/1"),
    });
    for (let i = 1; i <= MAX_PANES; i += 1) {
      list = joinTeam(list, "ws-1", `pane-${i}`, "team-1", `impl-${i}`);
    }
    expect(membersOf(list[0], "team-1")).toHaveLength(MAX_PANES);
    expect(joinTeam(list, "ws-1", `pane-${MAX_PANES + 1}`, "team-1", "extra")).toBe(list);
  });

  it("writes the membership by id, and the team keeps its directory whatever the roster does", () => {
    const on = joinTeam(base(), "ws-1", "pane-1", "team-1", "lead");
    expect(on[0].panes[0].team).toEqual({ teamId: "team-1", role: "lead" });
    expect(findTeam(on[0], "team-1")?.location).toEqual(attached("/wt/1"));
  });
});

describe("dissolveTeam", () => {
  it("removes a team with nobody on it, and refuses one with members", () => {
    // A team is dissolved empty: its members come off it only by closing,
    // which is the close flow's, not a transform here.
    const base = createTeam([workspace("ws-1", [pane("pane-1")])], "ws-1", {
      id: "team-1",
      name: "api",
      location: attached("/wt/1"),
    });
    const on = joinTeam(base, "ws-1", "pane-1", "team-1", "lead");
    expect(dissolveTeam(on, "ws-1", "team-1")).toBe(on);
    expect(dissolveTeam(base, "ws-1", "team-1")[0].teams).toBeUndefined();
    expect(dissolveTeam(base, "ws-1", "team-9")).toBe(base);
  });
});
