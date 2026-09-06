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
import type { Workspace } from "../../domain/deck";

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
  it("is born with its directory and its first agent — a new worktree in a repo workspace", async () => {
    repoMode.isRepo = true;
    const { registry, deck } = setup([workspace({ worktreeBaseDir: "/wt" })]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "api", agentType: "claude" },
      HOST,
    );
    expect(result.ok).toBe(true);
    expect(value(result)).toMatchObject({
      teamId: "team-1",
      workspaceId: "ws-1",
      agentType: "claude",
      // The worktree ahead is the team's, and the answer says so.
      worktree: { path: "/wt/kd-web-1", branch: "kd/web/1" },
    });
    const ws = deck.workspaces[0];
    expect(ws.teams?.[0]).toMatchObject({
      name: "api",
      location: { kind: "provisioning", intent: { repo: "/repo", branch: "kd/web/1", index: 1 } },
    });
    expect(ws.panes[0].team).toEqual({ teamId: "team-1", role: "lead" });
  });

  it("runs in the workspace root, or in an existing directory, when told to", async () => {
    const { registry, deck } = setup([workspace({})]);
    const root = await registry.execute(
      "team.create",
      { workspace: "web", name: "root", directory: "root" },
      HOST,
    );
    expect(root.ok).toBe(true);
    expect(deck.workspaces[0].teams?.[0].location).toEqual({ kind: "attached", cwd: "/repo" });

    const elsewhere = await registry.execute(
      "team.create",
      { workspace: "web", name: "docs", directory: "/elsewhere/docs", role: "lead" },
      HOST,
    );
    expect(elsewhere.ok).toBe(true);
    expect(deck.workspaces[0].teams?.[1].location).toEqual({ kind: "attached", cwd: "/elsewhere/docs" });
    expect(deck.workspaces[0].panes[1].team).toEqual({ teamId: "team-2", role: "lead" });
  });

  it("refuses a new worktree where none can be made, and says what to pass instead", async () => {
    const { registry, deck } = setup([workspace({ worktreeBaseDir: null })]);
    const result = await registry.execute("team.create", { workspace: "web", name: "api" }, HOST);
    expect(result.ok).toBe(false);
    expect(message(result)).toContain('directory: "root"');
    expect(deck.workspaces[0].panes).toEqual([]);
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

  it("refuses a directory a team here already holds — one directory is one team", async () => {
    const { registry } = setup([teamed()]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", name: "second", directory: "/wt/api/" },
      HOST,
    );
    expect(result.ok).toBe(false);
    expect(message(result)).toContain("team-1");
  });

  it("refuses a role the deck does not know", async () => {
    const { registry } = setup([workspace({})]);
    const result = await registry.execute(
      "team.create",
      { workspace: "web", directory: "root", role: "wizard" },
      HOST,
    );
    expect(result.ok).toBe(false);
    expect(message(result)).toContain("wizard");
  });
});

describe("team.add", () => {
  it("puts a new agent on the team — by id or by name — under the role asked for", async () => {
    const { registry, deck } = setup([teamed()]);
    const byId = await registry.execute(
      "team.add",
      { workspace: "web", team: "team-1", agentType: "codex", role: "impl-1" },
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
    expect(members[1]).toEqual({ teamId: "team-1", role: "impl-1" });
    // No role asked: the roster suggests the next free one.
    expect(members[2]).toEqual({ teamId: "team-1", role: "impl-2" });
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
    const joined = await registry.execute(
      "agent.spawn",
      { workspace: "web", team: "api", role: "impl-1" },
      HOST,
    );
    expect(joined.ok).toBe(true);
    expect(value(joined)).toMatchObject({ teamId: "team-1" });
    expect(deck.workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-1" });

    const alone = await registry.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(alone.ok).toBe(true);
    expect(value(alone)).toMatchObject({ teamId: "team-2" });
    expect(deck.workspaces[0].teams?.[1].location).toEqual({ kind: "attached", cwd: "/repo" });
  });
});
