// FIRST, before anything that reaches the mocked IPC: the doubles register
// when this module evaluates, and `../coreCommands` pulls the real
// `ipc/worktree` in if it gets there first.
import {
  HOST,
  repoMode,
  resetCoreCommandTestState,
  setup,
  workspace,
} from "./testSupport";
import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_GONE_MESSAGE, type Workspace } from "../../domain/deck";

beforeEach(() => {
  resetCoreCommandTestState();
});

/** A workspace with one team on a worktree of its own, one member on it. */
const teamed = (over: Partial<Workspace> = {}): Workspace =>
  workspace({
    teams: [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/api" } }],
    panes: [{ id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } }],
    ...over,
  });

const value = (result: { ok: boolean; value?: unknown }) => result.value as Record<string, unknown>;
const message = (result: { ok: boolean; error?: { message: string } }) => result.error?.message ?? "";

describe("team.create", () => {
  it("is born EMPTY with its directory — a new worktree in a repo workspace, nobody on it", async () => {
    repoMode.isRepo = true;
    const { registry, deck, createTeam } = setup([workspace({ worktreeBaseDir: "/wt" })]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "api" },
      HOST,
    );
    expect(result.ok).toBe(true);
    expect(value(result)).toMatchObject({
      teamId: "team-1",
      workspaceId: "ws-1",
      name: "api",
      // The worktree ahead is the team's, and the answer says so.
      worktree: { path: "/wt/kd-web-1", branch: "kd/web/1" },
    });
    const ws = deck.workspaces[0];
    expect(ws.teams?.[0]).toMatchObject({
      name: "api",
      location: { kind: "provisioning", intent: { repo: "/repo", branch: "kd/web/1", index: 1 } },
    });
    // The same door "+ Team" goes through, and no agent behind it: the
    // agents come through team.add, one at a time, each under its role.
    expect(createTeam).toHaveBeenCalledExactlyOnceWith({
      workspace: { id: "ws-1", instance: ws.instance },
      name: "api",
      placement: ws.teams?.[0].location,
    });
    expect(ws.panes).toEqual([]);
  });

  it("runs in the workspace root, or in an existing directory, when told to — under an auto name when none is given", async () => {
    const { registry, deck } = setup([workspace({})]);
    const root = await registry.execute(
      "team.create",
      { workspace: "web", directory: "root" },
      HOST,
    );
    expect(root.ok).toBe(true);
    expect(value(root)).toMatchObject({ teamId: "team-1", name: "Team 1", worktree: null });
    expect(deck.workspaces[0].teams?.[0]).toMatchObject({
      name: "Team 1",
      location: { kind: "attached", cwd: "/repo" },
    });

    const elsewhere = await registry.execute(
      "team.create",
      { workspace: "web", name: "docs", directory: "/elsewhere/docs" },
      HOST,
    );
    expect(elsewhere.ok).toBe(true);
    expect(deck.workspaces[0].teams?.[1].location).toEqual({ kind: "attached", cwd: "/elsewhere/docs" });
    expect(deck.workspaces[0].panes).toEqual([]);
  });

  it("refuses a new worktree where none can be made, and says what to pass instead", async () => {
    const { registry, deck, createTeam } = setup([workspace({ worktreeBaseDir: null })]);
    const result = await registry.execute("team.create", { workspace: "web", name: "api" }, HOST);
    expect(result.ok).toBe(false);
    expect(message(result)).toContain('directory: "root"');
    expect(createTeam).not.toHaveBeenCalled();
    expect(deck.workspaces[0].teams ?? []).toEqual([]);
  });

  it("refuses a name a team here already holds, pointing at team.add", async () => {
    const { registry } = setup([teamed()]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: " API ", directory: "root" },
      HOST,
    );
    expect(result.ok).toBe(false);
    expect(message(result)).toContain("team.add");
  });

  it("refuses a directory a team here works in unasked — naming the team, and the way to mean it", async () => {
    const { registry } = setup([teamed()]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "second", directory: "/wt/api/" },
      HOST,
    );
    expect(result.ok).toBe(false);
    // Joining is what an agent usually means, so the refusal names the team
    // team.add would put it on — and the flag for when it meant the other.
    expect(message(result)).toContain("team-1");
    expect(message(result)).toContain("shared: true");
  });

  it("says a worktree create is heading there, which no flag can overrule", async () => {
    const { registry, createTeam } = setup([teamed()]);
    createTeam.mockReturnValueOnce({ kind: "held", why: "creating" });
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "second", directory: "/wt/pending", shared: true },
      HOST,
    );
    expect(result.ok).toBe(false);
    expect(message(result)).toContain("still being created");
  });

  it("never points an agent at a team.add it cannot reach — a holder abroad is named as such", async () => {
    // team.add resolves a team inside the CALLING workspace only. Saying
    // "team.add puts an agent on it" about a team in another workspace sends
    // the agent to an error; the two cases were two messages for that reason.
    const { registry, createTeam } = setup([teamed()]);
    createTeam.mockReturnValueOnce({
      kind: "shared",
      directory: "/wt/api",
      holder: { teamId: "team-1", teamName: "api", workspace: "site" },
    });
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "second", directory: "/wt/api" },
      HOST,
    );
    expect(result.ok).toBe(false);
    expect(message(result)).toContain("workspace “site”");
    expect(message(result)).not.toContain("team.add puts an agent on it");
    // It still says the way to mean it.
    expect(message(result)).toContain("shared: true");
  });

  it("makes the second team in the directory when the agent says it means it", async () => {
    const { registry, deck } = setup([teamed()]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "second", directory: "/wt/api/", shared: true },
      HOST,
    );
    expect(result.ok).toBe(true);
    const teams = deck.workspaces[0].teams ?? [];
    expect(teams).toHaveLength(2);
    expect(teams.map((team) => team.name)).toEqual(["api", "second"]);
    expect(
      teams.every(
        (team) => team.location?.kind === "attached" && team.location.cwd.startsWith("/wt/api"),
      ),
    ).toBe(true);
  });

  it("refuses a directory another workspace's team holds, naming whose — except the root, which every workspace holds for itself", async () => {
    // team.add cannot reach a team in another workspace, so the refusal
    // says which workspace to go to instead of a bare "held".
    const { registry, deck } = setup([
      workspace({}),
      workspace({
        id: "ws-2",
        name: "site",
        teams: [{ id: "team-1", name: "shared", location: { kind: "attached", cwd: "/wt/shared" } }],
      }),
    ]);
    const abroad = await registry.execute(
      "team.create",
      { workspace: "web", name: "mine", directory: "/wt/shared/" },
      HOST,
    );
    expect(abroad.ok).toBe(false);
    expect(message(abroad)).toContain("shared");
    expect(message(abroad)).toContain("site");
    expect(deck.workspaces[0].teams ?? []).toEqual([]);

    // Both workspaces sit on /repo: a team on the root here is not a
    // team on the root there.
    const rootThere = await registry.execute(
      "team.create",
      { workspace: "site", name: "root", directory: "root" },
      HOST,
    );
    expect(rootThere.ok).toBe(true);
    const rootHere = await registry.execute(
      "team.create",
      { workspace: "web", name: "root", directory: "root" },
      HOST,
    );
    expect(rootHere.ok).toBe(true);
    expect(deck.workspaces[0].teams?.[0].location).toEqual({ kind: "attached", cwd: "/repo" });
  });

  it("says so when the workspace is gone by the time the team would be made", async () => {
    // The landing's own refusal, translated: a caller that got a teamId
    // for a team no workspace holds would go on addressing it.
    const { registry, createTeam } = setup([workspace({})]);
    createTeam.mockReturnValueOnce({ kind: "gone" });
    const result = await registry.execute(
      "team.create",
      { workspace: "web", directory: "root" },
      HOST,
    );
    expect(result.ok).toBe(false);
    expect(message(result)).toBe(WORKSPACE_GONE_MESSAGE);
  });
});

describe("team.add", () => {
  it("puts a new agent on the team — by id or by name — under the role asked for", async () => {
    const { registry, deck } = setup([teamed()]);
    // "reviewer-1", not the "impl-1" the roster would suggest beside a lone
    // lead: the role ASKED for has to be the one that lands.
    const byId = await registry.execute(
      "team.add",
      { workspace: "web", team: "team-1", agentType: "codex", role: "reviewer-1" },
      HOST,
    );
    expect(byId.ok).toBe(true);
    expect(value(byId)).toMatchObject({ teamId: "team-1" });
    const byName = await registry.execute(
      "team.add",
      { workspace: "web", team: " Api " },
      HOST,
    );
    expect(byName.ok).toBe(true);
    const members = deck.workspaces[0].panes.map((pane) => pane.team);
    expect(members[1]).toEqual({ teamId: "team-1", role: "reviewer-1" });
    // No role asked: the roster suggests the next free one.
    expect(members[2]).toEqual({ teamId: "team-1", role: "impl-1" });
    expect(deck.workspaces[0].teams).toHaveLength(1);
  });

  it("refuses a team that is not here, a taken role, and an unknown one", async () => {
    const { registry } = setup([teamed()]);
    const missing = await registry.execute("team.add", { workspace: "web", team: "nope" }, HOST);
    expect(missing.ok).toBe(false);
    expect(message(missing)).toContain('no team "nope"');
    const taken = await registry.execute(
      "team.add",
      { workspace: "web", team: "team-1", role: "lead" },
      HOST,
    );
    expect(taken.ok).toBe(false);
    expect(message(taken)).toContain("taken");
    const unknown = await registry.execute(
      "team.add",
      { workspace: "web", team: "team-1", role: "wizard" },
      HOST,
    );
    expect(unknown.ok).toBe(false);
  });

  it("refuses a seventeenth member — sixteen on one team is the cap", async () => {
    const crowd = Array.from({ length: 16 }, (_, i) => ({
      id: `p${i}`,
      agentType: "claude" as const,
      team: { teamId: "team-1", role: i === 0 ? "lead" : `impl-${i}` },
    }));
    const { registry, deck } = setup([teamed({ panes: crowd })]);
    const result = await registry.execute("team.add", { workspace: "web", team: "team-1" }, HOST);
    expect(result.ok).toBe(false);
    expect(message(result)).toContain("full");
    expect(deck.workspaces[0].panes).toHaveLength(16);
  });
});

describe("agent.spawn as the compatibility door", () => {
  it("with a team, is team.add; without, a team of its own — and answers the team either way", async () => {
    const { registry, deck } = setup([teamed()]);
    // A role the roster would not have suggested, so a door that dropped it
    // could not pass by luck.
    const joined = await registry.execute(
      "agent.spawn",
      { workspace: "web", team: "api", role: "reviewer-1" },
      HOST,
    );
    expect(joined.ok).toBe(true);
    expect(value(joined)).toMatchObject({ teamId: "team-1" });
    expect(deck.workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "reviewer-1" });

    const alone = await registry.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(alone.ok).toBe(true);
    expect(value(alone)).toMatchObject({ teamId: "team-2" });
    expect(deck.workspaces[0].teams?.[1].location).toEqual({ kind: "attached", cwd: "/repo" });
  });
});
