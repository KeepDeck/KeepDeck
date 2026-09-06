// FIRST, before anything that reaches the mocked IPC — see testSupport.
import {
  HOST,
  resetCoreCommandTestState,
  setup,
  twoWorkspaces,
  workspace,
} from "./testSupport";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  resetCoreCommandTestState();
});

describe("workspace commands", () => {
  it("lists workspaces with active flag and header titles", async () => {
    const { registry, deck } = setup([
      workspace({ panes: [{ id: "p1", agentType: "claude" }] }),
      workspace({ id: "ws-2", name: "site", cwd: "/site" }),
    ]);
    vi.mocked(deck.viewOf).mockImplementation((workspaceId) =>
      workspaceId === "ws-1" ? { select: "p1" } : {},
    );
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual([
        {
          id: "ws-1",
          name: "web",
          cwd: "/repo",
          active: true,
          teams: [],
          panes: [
            {
              id: "p1",
              title: "Claude 1",
              agentType: "claude",
              branch: null,
              cwd: "/repo",
              activity: null,
              team: null,
            },
          ],
        },
        {
          id: "ws-2",
          name: "site",
          cwd: "/site",
          active: false,
          teams: [],
          panes: [],
        },
      ]);
  });

  it("lists the teams — where each runs, its state, its members — and each pane's team by id", async () => {
    const { registry } = setup([
      workspace({
        teams: [
          { id: "team-1", name: "api", location: { kind: "attached", cwd: "/wt/api", branch: "kd/api" } },
          {
            id: "team-2",
            name: "web",
            location: {
              kind: "provisioning",
              intent: { repo: "/repo", path: "/wt/web", branch: "kd/web", index: 2 },
              error: "boom",
            },
          },
        ],
        panes: [
          { id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
          { id: "p2", agentType: "claude", team: { teamId: "team-1", role: "impl-1" } },
          { id: "p3", agentType: "claude", team: { teamId: "team-2", role: "lead" } },
        ],
      }),
    ]);
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = result.value as {
      teams: unknown[];
      panes: { id: string; team: unknown; cwd: string | null }[];
    }[];
    expect(row.teams).toEqual([
      { id: "team-1", name: "api", status: "ready", cwd: "/wt/api", branch: "kd/api", members: ["p1", "p2"] },
      // A create that failed: no directory to name, the branch it was
      // heading for, Retry on offer.
      { id: "team-2", name: "web", status: "failed", cwd: null, branch: "kd/web", members: ["p3"] },
    ]);
    expect(row.panes.map((pane) => pane.team)).toEqual([
      { id: "team-1", name: "api", role: "lead" },
      { id: "team-1", name: "api", role: "impl-1" },
      { id: "team-2", name: "web", role: "lead" },
    ]);
    expect(row.panes[2].cwd).toBeNull();
  });

  it("reports no cwd for a pane whose worktree is still being created", async () => {
    // The pane will run in the worktree once it exists. Answering the
    // workspace cwd meanwhile told a teammate to look for it — and write
    // beside it — in a directory it never runs in.
    const { registry } = setup([
      workspace({
        teams: [
          {
            id: "team-1",
            name: "web-1",
            location: {
              kind: "provisioning",
              intent: { repo: "/repo", path: "/wt/web-1", branch: "kd/web/1", index: 1 },
            },
          },
        ],
        panes: [{ id: "p1", agentType: "claude", team: { teamId: "team-1", role: "lead" } }],
      }),
    ]);
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows = result.value as { panes: { id: string; cwd: string | null }[] }[];
      expect(rows[0].panes[0]).toMatchObject({ id: "p1", cwd: null, branch: null });
    }
  });

  it("carries what each agent is DOING, so asking a teammate costs nothing", async () => {
    // The deck sees this from outside; a session cannot see it at all. An
    // agent that has to ask "are you done yet?" spends a turn, waits for a
    // reply, and pays for both — so anything the host already knows belongs
    // in the answer it gives for free.
    const { registry, activityOf } = setup([
      workspace({
        panes: [
          { id: "p1", agentType: "claude" },
          { id: "p2", agentType: "claude" },
        ],
      }),
    ]);
    activityOf.mockImplementation((paneId) =>
      paneId === "p1"
        ? { state: "working", since: 500 }
        : { state: "waiting", since: 700, reason: "permission" },
    );
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const panes = (result.value as { panes: { activity: unknown }[] }[])[0].panes;
      expect(panes[0].activity).toEqual({ state: "working", since: 500 });
      expect(panes[1].activity).toEqual({
        state: "waiting",
        since: 700,
        reason: "permission",
      });
    }
  });

  it("reports a pane nothing speaks for as unknown, not as idle", async () => {
    // Provisioning, stopped, or a CLI with no status reporter. Absent
    // information about a live pane, which is a different thing from a pane
    // that has finished — and a lead reading the roster must not confuse
    // them.
    const { registry } = setup([
      workspace({ panes: [{ id: "p1", agentType: "claude" }] }),
    ]);
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const panes = (result.value as { panes: { activity: unknown }[] }[])[0].panes;
      expect(panes[0].activity).toBeNull();
    }
  });

  it("resolves the exact active input target without guessing", async () => {
    const { registry, deck } = setup([
      workspace({
        panes: [
          { id: "p1", agentType: "claude" },
          { id: "p2", agentType: "codex" },
        ],
      }),
    ]);
    vi.mocked(deck.viewOf).mockReturnValue({ select: "p2" });

    const selected = await registry.execute("pane.target", {}, HOST);
    expect(selected).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", paneId: "p2", teamId: null },
    });

    vi.mocked(deck.viewOf).mockReturnValue({});
    const ambiguous = await registry.execute("pane.target", {}, HOST);
    expect(ambiguous).toEqual({
      ok: false,
      error: {
        code: "failed",
        message: 'no agent selected in workspace "web"',
      },
    });
  });

  it("switches by case-insensitive name and refuses unknowns", async () => {
    const { registry, deck } = setup([
      workspace({}),
      workspace({ id: "ws-2", name: "site" }),
    ]);
    const ok = await registry.execute("workspace.switch", { workspace: "SITE" }, HOST);
    expect(ok).toEqual({ ok: true, value: { workspaceId: "ws-2" } });
    expect(deck.selectWorkspace).toHaveBeenCalledWith("ws-2");

    const bad = await registry.execute("workspace.switch", { workspace: "nope" }, HOST);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toBe('no workspace "nope"');
  });

  it("refuses a blank workspace instead of reporting a switch that never happened", async () => {
    // The registry accepts "" for a required string — it validates presence and
    // type, and blankness depends on what the argument IS. Read with the
    // OPTIONAL reader, a blank one became "omitted", which resolves to the
    // ACTIVE workspace: the caller got ok and a workspaceId for the workspace it
    // was already in, and nothing said its argument was junk.
    const { registry, deck } = setup(twoWorkspaces());

    const blank = await registry.execute("workspace.switch", { workspace: "  " }, HOST);

    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.message).toBe('argument "workspace" must not be blank');
    expect(deck.selectWorkspace).not.toHaveBeenCalled();
  });
});
