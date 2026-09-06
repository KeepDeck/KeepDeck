import { describe, expect, it } from "vitest";
import {
  DECK_MIN_READER,
  DECK_STATE_VERSION,
  migrateDeck,
  settingsFloorBreach,
  SETTINGS_VERSION,
} from "./migrations";

describe("migrateDeck — revision ladder + compatibility floor", () => {
  it("the deck + settings revisions are the expected values", () => {
    // Pin the bumps so a forgotten version bump (the r3 SETTINGS miss) fails
    // loudly rather than silently shrinking the ladder-loop's coverage.
    expect(DECK_STATE_VERSION).toBe(11);
    expect(SETTINGS_VERSION).toBe(21);
  });

  it("upgrades a v1 document hop by hop to the current revision", () => {
    const out = migrateDeck({ version: 1, workspaces: [], marker: "kept" });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.doc.version).toBe(DECK_STATE_VERSION);
    expect(out.doc.marker).toBe("kept"); // steps transform, never truncate
  });

  it("the ladder has no holes: every past revision reaches the current one", () => {
    for (let v = 1; v <= DECK_STATE_VERSION; v++) {
      const out = migrateDeck({ version: v });
      expect(out.kind).toBe("ok");
      if (out.kind === "ok") expect(out.doc.version).toBe(DECK_STATE_VERSION);
    }
  });

  it("reads a NEWER revision as-is when its floor admits this build", () => {
    // The forward-compat contract: an additive future is not our problem —
    // the tolerant reader + extras preservation take it from here.
    const doc = { version: DECK_STATE_VERSION + 5, minVersion: 1, future: true };
    const out = migrateDeck(doc);
    expect(out).toEqual({ kind: "ok", doc });
  });

  it("parks a file whose floor is above this build", () => {
    expect(
      migrateDeck({ version: 9, minVersion: DECK_STATE_VERSION + 1 }),
    ).toEqual({ kind: "incompatible", version: 9, minVersion: DECK_STATE_VERSION + 1 });
  });

  it("a newer file WITHOUT a declared floor can only promise itself — parked", () => {
    // Pre-floor writers never emitted minVersion; a future build that
    // stopped writing it gets the conservative treatment.
    const out = migrateDeck({ version: DECK_STATE_VERSION + 1 });
    expect(out.kind).toBe("incompatible");
  });

  it("rejects revisions below the ladder's floor and non-numeric versions", () => {
    expect(migrateDeck({ version: 0 }).kind).toBe("unusable");
    expect(migrateDeck({ version: "1" }).kind).toBe("unusable");
    expect(migrateDeck({}).kind).toBe("unusable");
  });

  it("this build writes a floor no higher than itself", () => {
    // A floor above the writer's own revision would park the writer's own
    // files — a nonsense state the constants must never reach.
    expect(DECK_MIN_READER).toBeLessThanOrEqual(DECK_STATE_VERSION);
  });
});

describe("migrateDeck — v4 → v5: Workspace.run retirement", () => {
  it("moves run.setup and run.presets to Workspace.setup and the run plugin's slot, dropping run", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [
        {
          id: "ws-1",
          run: {
            setup: "pnpm i",
            presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
          },
        },
      ],
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect(ws.run).toBeUndefined();
  });

  it("moves only setup when presets are empty, still dropping run", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [{ id: "ws-1", run: { setup: "pnpm i", presets: [] } }],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toBeUndefined();
    expect(ws.run).toBeUndefined();
  });

  it("moves only presets when setup is absent, still dropping run", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [
        {
          id: "ws-1",
          run: { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
        },
      ],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBeUndefined();
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect(ws.run).toBeUndefined();
  });

  it("leaves a workspace without a run object untouched", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [{ id: "ws-1", name: "x" }],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.doc.workspaces).toEqual([{ id: "ws-1", name: "x" }]);
  });

  it("overwrites a pre-existing keepdeck.run plugin slot with the migrated presets", () => {
    const out = migrateDeck({
      version: 4,
      workspaces: [
        {
          id: "ws-1",
          plugins: {
            "keepdeck.run": { presets: [{ id: "old", name: "Old", command: "old cmd" }] },
            other: { kept: true },
          },
          run: { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
        },
      ],
    });
    if (out.kind !== "ok") throw new Error("expected ok");
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.plugins).toEqual({
      other: { kept: true },
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
  });

  it("a v2-era document (pre-plugins) climbs the whole ladder to v5, migrating run along the way", () => {
    const out = migrateDeck({
      version: 2,
      workspaces: [
        {
          id: "ws-1",
          run: {
            setup: "pnpm i",
            presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }],
          },
        },
      ],
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.doc.version).toBe(DECK_STATE_VERSION);
    const ws = (out.doc.workspaces as Record<string, unknown>[])[0];
    expect(ws.setup).toBe("pnpm i");
    expect(ws.plugins).toEqual({
      "keepdeck.run": { presets: [{ id: "run-1", name: "Dev", command: "pnpm dev" }] },
    });
    expect(ws.run).toBeUndefined();
  });
});

describe("migrateDeck — v10 → v11: a team is a directory's worth of agents", () => {
  type Raw = Record<string, unknown>;
  const v10 = (workspaces: unknown[]) => ({ version: 10, minVersion: 1, workspaces });
  const migrate = (workspaces: unknown[]) => {
    const out = migrateDeck(v10(workspaces));
    if (out.kind !== "ok") throw new Error(out.kind);
    return {
      workspaces: out.doc.workspaces as Raw[],
      notices: (out.doc.migrationNotices as string[] | undefined) ?? [],
    };
  };
  const ws = (id: string, panes: unknown[], over: Raw = {}): Raw => ({
    id,
    name: id,
    cwd: `/${id}`,
    worktreeBaseDir: null,
    panes,
    ...over,
  });
  const teamsOf = (workspace: Raw) => workspace.teams as Raw[] | undefined;
  const panesOf = (workspace: Raw) => workspace.panes as Raw[];

  it("a named team whose members share one directory survives intact, on that directory", () => {
    // The live deck's own shape: four agents of one team in one worktree.
    const { workspaces, notices } = migrate([
      ws("ws-10", [
        { id: "pane-247", agentType: "claude", cwd: "/wt/kd-1", branch: "kd/1", team: { name: "updates", role: "lead" }, name: "ui update" },
        { id: "pane-248", agentType: "opencode", cwd: "/wt/kd-1", branch: "kd/1", team: { name: "updates", role: "impl-1" } },
        { id: "pane-249", agentType: "opencode", cwd: "/wt/kd-1", branch: "kd/1", team: { name: " Updates ", role: "impl-2" } },
      ]),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([
      { id: "team-1", name: "updates", cwd: "/wt/kd-1", branch: "kd/1" },
    ]);
    expect(panesOf(workspaces[0])).toEqual([
      { id: "pane-247", agentType: "claude", name: "ui update", team: { teamId: "team-1", role: "lead" } },
      { id: "pane-248", agentType: "opencode", team: { teamId: "team-1", role: "impl-1" } },
      { id: "pane-249", agentType: "opencode", team: { teamId: "team-1", role: "impl-2" } },
    ]);
    expect(notices).toEqual([]);
  });

  it("a named team spread over directories is dissolved: directories and sessions stay, name and roles go", () => {
    const { workspaces, notices } = migrate([
      ws("ws-1", [
        { id: "pane-1", cwd: "/wt/1", session: { id: "s1", boundAt: "t" }, team: { name: "api", role: "lead" } },
        { id: "pane-2", cwd: "/wt/2", session: { id: "s2", boundAt: "t" }, team: { name: "api", role: "impl-1" } },
      ]),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([
      { id: "team-1", name: "Team 1", cwd: "/wt/1" },
      { id: "team-2", name: "Team 2", cwd: "/wt/2" },
    ]);
    // Each agent keeps its directory and its session, and answers to a
    // minted address on its own team of one.
    expect(panesOf(workspaces[0])).toEqual([
      { id: "pane-1", session: { id: "s1", boundAt: "t" }, team: { teamId: "team-1", role: "lead" } },
      { id: "pane-2", session: { id: "s2", boundAt: "t" }, team: { teamId: "team-2", role: "lead" } },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("“api”");
    expect(notices[0]).toContain("2 directories");
  });

  it("the workspace root is a directory like any other: its panes form a team, a remote pane joins it", () => {
    const { workspaces } = migrate([
      ws("ws-14", [
        { id: "pane-264", branch: "main", team: { name: "isp team", role: "lead" }, name: "isp lead" },
        { id: "pane-265", team: { name: "isp team", role: "impl-1" } },
        { id: "pane-9", remoteEndpoint: "ws://vps:4500", cwd: "/elsewhere" },
      ]),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([
      { id: "team-1", name: "isp team", cwd: "/ws-14", branch: "main" },
    ]);
    // The roster's roles stay; the pane the roster did not name gets the
    // next free address; a remote endpoint is the pane's own and stays.
    expect(panesOf(workspaces[0])).toEqual([
      { id: "pane-264", name: "isp lead", team: { teamId: "team-1", role: "lead" } },
      { id: "pane-265", team: { teamId: "team-1", role: "impl-1" } },
      { id: "pane-9", remoteEndpoint: "ws://vps:4500", team: { teamId: "team-1", role: "impl-2" } },
    ]);
  });

  it("names a directory's team after its first member's own name, else Team N — unique by key", () => {
    const { workspaces } = migrate([
      ws("ws-8", [
        { id: "pane-1", cwd: "/a", name: "pressroom impl" },
        { id: "pane-2", cwd: "/b" },
        { id: "pane-3", cwd: "/c", name: "Pressroom Impl" },
        { id: "pane-4", cwd: "/c" },
      ]),
    ]);
    expect(teamsOf(workspaces[0])?.map((team) => team.name)).toEqual([
      "pressroom impl",
      "Team 2",
      "Pressroom Impl 2",
    ]);
    // A directory of two unnamed agents: a lead, then the first free impl.
    expect(panesOf(workspaces[0]).map((pane) => pane.team)).toEqual([
      { teamId: "team-1", role: "lead" },
      { teamId: "team-2", role: "lead" },
      { teamId: "team-3", role: "lead" },
      { teamId: "team-3", role: "impl-1" },
    ]);
  });

  it("mints ids across the document in reading order, and the same file gives the same ids", () => {
    const doc = [
      ws("ws-1", [{ id: "pane-1", cwd: "/wt/1" }, { id: "pane-2" }]),
      ws("ws-2", [{ id: "pane-3", cwd: "/wt/1/" }]),
    ];
    const once = migrate(doc);
    const twice = migrate(doc);
    expect(once).toEqual(twice);
    expect(teamsOf(once.workspaces[0])?.map((team) => team.id)).toEqual(["team-1", "team-2"]);
    // A second workspace's team is its own object even on a directory the
    // first one uses: a team never spans workspaces — occupancy, not this
    // hop, is what refuses two teams in one directory.
    expect(teamsOf(once.workspaces[1])).toEqual([{ id: "team-3", name: "Team 3", cwd: "/wt/1/" }]);
  });

  it("a create in flight moves onto the team as its intent, and the pane is left plain", () => {
    const intent = { repo: "/ws-1", path: "/wt/pending", branch: "kd/5", index: 5 };
    const { workspaces } = migrate([
      ws("ws-1", [
        { id: "pane-1", provisioning: intent },
        { id: "pane-2", provisioning: { ...intent, path: "/wt/pending/" } },
      ]),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([{ id: "team-1", name: "Team 1", provisioning: intent }]);
    expect(panesOf(workspaces[0])).toEqual([
      { id: "pane-1", team: { teamId: "team-1", role: "lead" } },
      { id: "pane-2", team: { teamId: "team-1", role: "impl-1" } },
    ]);
  });

  it("one directory is one team: a second intact name there is merged in with its roles, a duplicate role re-minted", () => {
    // "web" is consistent — all its members sit here — so it keeps what it
    // can: its roles, under the first team's name. Only a collision costs a
    // role, and the person is told which.
    const { workspaces, notices } = migrate([
      ws("ws-1", [
        { id: "pane-1", cwd: "/wt/1", team: { name: "api", role: "lead" } },
        { id: "pane-2", cwd: "/wt/1", team: { name: "web", role: "impl-1" } },
        { id: "pane-3", cwd: "/wt/1", team: { name: "web", role: "LEAD" } },
        { id: "pane-4", cwd: "/wt/1", team: { name: "api", role: "impl-1" } },
      ]),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([{ id: "team-1", name: "api", cwd: "/wt/1" }]);
    expect(panesOf(workspaces[0]).map((pane) => pane.team)).toEqual([
      { teamId: "team-1", role: "lead" },
      { teamId: "team-1", role: "impl-1" },
      { teamId: "team-1", role: "impl-2" },
      { teamId: "team-1", role: "impl-3" },
    ]);
    expect(notices).toEqual([
      "Team “web” in workspace “ws-1” shared a directory with team “api” and was merged into it: one directory is one team.",
      "In team “api” (workspace “ws-1”) two agents held the role “LEAD”; the second now answers to a minted one.",
      "In team “api” (workspace “ws-1”) two agents held the role “impl-1”; the second now answers to a minted one.",
    ]);
  });

  it("a mixed root group: the branch is the first RECORDED one, and every root pane joins", () => {
    // A remote pane first, then two root panes on different recorded
    // branches. The directory has one branch: the first anyone recorded.
    // Every pane in the root joins the root's team — a pane outside a team
    // does not exist any more, and a remote pane keeps its endpoint.
    const { workspaces, notices } = migrate([
      ws("ws-1", [
        { id: "pane-1", remoteEndpoint: "ws://vps" },
        { id: "pane-2", branch: "feature/a" },
        { id: "pane-3", branch: "feature/b" },
      ]),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([{ id: "team-1", name: "Team 1", cwd: "/ws-1", branch: "feature/a" }]);
    expect(panesOf(workspaces[0])).toEqual([
      { id: "pane-1", remoteEndpoint: "ws://vps", team: { teamId: "team-1", role: "lead" } },
      { id: "pane-2", team: { teamId: "team-1", role: "impl-1" } },
      { id: "pane-3", team: { teamId: "team-1", role: "impl-2" } },
    ]);
    expect(notices).toEqual([]);
  });

  it("a workspace without worktrees: its unrelated root agents become ONE team", () => {
    // The decided shape — the root is a directory like any other, and a
    // directory's agents are its team — pinned so it is a decision rather
    // than a surprise.
    const { workspaces } = migrate([
      ws("ws-5", [{ id: "pane-1" }, { id: "pane-2" }, { id: "pane-3" }], { worktreeBaseDir: null }),
    ]);
    expect(teamsOf(workspaces[0])).toEqual([{ id: "team-1", name: "Team 1", cwd: "/ws-5" }]);
    expect(panesOf(workspaces[0]).map((pane) => (pane.team as Raw | undefined)?.role)).toEqual([
      "lead",
      "impl-1",
      "impl-2",
    ]);
  });

  it("names its notices in words a person can act on", () => {
    const { notices } = migrate([
      ws("ws-1", [
        { id: "pane-1", cwd: "/wt/1", team: { name: "api", role: "lead" } },
        { id: "pane-2", cwd: "/wt/2", team: { name: "api", role: "impl-1" } },
      ]),
    ]);
    expect(notices).toEqual([
      "Team “api” in workspace “ws-1” ran in 2 directories and was dissolved: its agents keep their directories and sessions, and lost the team name and roles.",
    ]);
  });

  it("reads a half-written membership as none, and leaves a workspace without panes untouched", () => {
    const { workspaces } = migrate([
      { id: "ws-0", marker: "kept" },
      ws("ws-1", [
        { id: "pane-1", team: { name: "api" } },
        { id: "pane-2", team: { role: "lead" }, yolo: true, extra: "kept" },
        { id: "pane-3", team: { name: "   ", role: "lead" } },
        { id: "pane-4", team: "api" },
      ]),
    ]);
    expect(workspaces[0]).toEqual({ id: "ws-0", marker: "kept" });
    expect(teamsOf(workspaces[1])).toEqual([{ id: "team-1", name: "Team 1", cwd: "/ws-1" }]);
    expect(panesOf(workspaces[1])).toEqual([
      { id: "pane-1", team: { teamId: "team-1", role: "lead" } },
      { id: "pane-2", yolo: true, extra: "kept", team: { teamId: "team-1", role: "impl-1" } },
      { id: "pane-3", team: { teamId: "team-1", role: "impl-2" } },
      { id: "pane-4", team: { teamId: "team-1", role: "impl-3" } },
    ]);
  });
});

describe("settingsFloorBreach", () => {
  it("admits anything at or below this build, and unmarked documents", () => {
    expect(settingsFloorBreach({ version: 1 })).toBeNull();
    expect(settingsFloorBreach({ version: 99, minVersion: 1 })).toBeNull();
    expect(settingsFloorBreach({})).toBeNull(); // hand-made file, no markers
  });

  it("admits a bare high version with no declared floor (reads tolerantly)", () => {
    // A hand-edited `version` bump must not nuke every setting to defaults —
    // only an explicit minVersion above this build shuts us out.
    expect(settingsFloorBreach({ version: 99, scrollback: 42 })).toBeNull();
  });

  it("reports a floor above this build", () => {
    expect(
      settingsFloorBreach({ version: 99, minVersion: SETTINGS_VERSION + 1 }),
    ).toBe(SETTINGS_VERSION + 1);
  });
});
