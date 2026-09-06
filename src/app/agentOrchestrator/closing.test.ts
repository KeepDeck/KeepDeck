// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import {
  Probe,
  agentRun,
  catalog,
  createWorkspaceInstance,
  deck,
  discards,
  dropPaneSpawnSpec,
  ipc,
  pty,
  published,
  resetPaneSpawnSpecs,
  setDiscardFailures,
  steps,
  lifecycle,
} from "./testSupport";

/**
 * The close coordinator: one agent, one team, one workspace — three verbs,
 * and the races between them. A directory is a TEAM's, so only a disband
 * (or a workspace close, which disbands every team) can take one; whoever
 * captures a team first does everything for it, once.
 */

const target = { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" };
const made = { repo: "/repo", path: "/wt/9", branch: "kd/ws/9" };

/** The live ref of a workspace in the deck. */
const refOf = (wsId: string): WorkspaceRef => {
  const ws = deck.workspaces.find((candidate) => candidate.id === wsId);
  if (!ws) throw new Error(`${wsId} is not in the deck`);
  return { id: ws.id, instance: ws.instance };
};

const teamIds = (wsId: string) =>
  deck.workspaces.find((ws) => ws.id === wsId)?.teams?.map((team) => team.id) ?? [];
const paneIds = (wsId: string) =>
  deck.workspaces.find((ws) => ws.id === wsId)?.panes.map((pane) => pane.id) ?? [];

/** Two teams: one on the repo root, one on a worktree of its own. */
function seed() {
  act(() =>
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
        { id: "pane-2", agentType: "claude", team: { teamId: "team-2", role: "lead" } },
      ],
      teams: [
        { id: "team-1", name: "root", location: { kind: "attached", cwd: "/repo" } },
        { id: "team-2", name: "two", location: { kind: "attached", cwd: "/wt/2", branch: "kd/ws/2" } },
      ],
    }),
  );
}

/** A second workspace whose one team is still creating its worktree. */
function creating() {
  act(() =>
    deck.createWorkspace({
      id: "ws-2",
      instance: createWorkspaceInstance(),
      name: "two",
      cwd: "/repo",
      worktreeBaseDir: "/wt",
      panes: [{ id: "pane-9", agentType: "claude", team: { teamId: "team-9", role: "lead" } }],
      teams: [
        {
          id: "team-9",
          name: "nine",
          location: {
            kind: "provisioning",
            intent: { repo: "/repo", path: "/wt/two-1", index: 1 },
          },
        },
      ],
    }),
  );
}

/** A create ticket a test settles by hand. */
function pendingTicket(teamId: string) {
  let publish!: (worktree: typeof made | null) => void;
  published.set(
    teamId,
    new Promise((resolve) => {
      publish = resolve;
    }),
  );
  return publish;
}

let root: Root;

beforeEach(() => {
  resetPaneSpawnSpecs();
  vi.mocked(dropPaneSpawnSpec).mockClear();
  lifecycle.retire.mockClear();
  steps.clear.mockClear();
  setDiscardFailures([]);
  ipc.probeWorktree.mockReset().mockResolvedValue({
    exists: true,
    isWorktree: false,
    empty: false,
    branch: null,
  });
  catalog.ready = true;
  catalog.parkOnLaunch = false;
  pty.reset();
  document.body.innerHTML = "<div id='host'></div>";
  root = createRoot(document.getElementById("host")!);
  act(() => root.render(createElement(Probe)));
  seed();
});

afterEach(() => {
  act(() => root.unmount());
  published.clear();
});

describe("agent orchestrator —closing an agent", () => {
  it("takes one pane out of the deck and ends exactly its process — the team stays", async () => {
    await act(async () =>
      agentRun.close({ kind: "agent", workspace: refOf("ws-1"), paneId: "pane-1" }),
    );
    expect(paneIds("ws-1")).toEqual(["pane-2"]);
    // An empty team keeps its directory and its card.
    expect(teamIds("ws-1")).toEqual(["team-1", "team-2"]);
    expect(pty.closed).toEqual(["pane-1"]);
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(lifecycle.retire).toHaveBeenCalledWith("pane-1");
    // The fork step is the TEAM's, and the team is still here.
    expect(steps.clear).not.toHaveBeenCalled();
    expect(discards).toEqual([]);
  });

  it("never takes the team's worktree — a member leaving is not a disband", async () => {
    // The last member of a team on a worktree: even its close is only the
    // agent's. There is no box to tick on an agent close, and no list.
    const failures = await act(async () =>
      agentRun.close({ kind: "agent", workspace: refOf("ws-1"), paneId: "pane-2" }),
    );
    expect(failures).toEqual([]);
    expect(discards).toEqual([]);
    expect(deck.workspaces[0].teams?.find((team) => team.id === "team-2")?.location).toEqual({
      kind: "attached",
      cwd: "/wt/2",
      branch: "kd/ws/2",
    });
  });

  it("revokes the bridge token BEFORE the reducer forgets the pane", async () => {
    // The reverse of a suspend's order, and deliberately: a reporter still in
    // flight — or a later pane reusing the id — must not be able to write.
    const order: string[] = [];
    vi.mocked(dropPaneSpawnSpec).mockImplementationOnce(() => {
      order.push(`revoked:${deck.workspaces[0].panes.length}`);
    });
    await act(async () =>
      agentRun.close({ kind: "agent", workspace: refOf("ws-1"), paneId: "pane-1" }),
    );
    expect(order).toEqual(["revoked:2"]);
  });

  it("a member of a team a confirmed close holds is that close's to end — reaped once", async () => {
    creating();
    const publish = pendingTicket("team-9");
    let disbanding!: Promise<string[]>;
    act(() => {
      disbanding = agentRun.close({
        kind: "team",
        workspace: refOf("ws-2"),
        teamId: "team-9",
        deleteWorktrees: false,
        worktrees: [],
      });
    });
    // The disband is waiting on the create; a member close meanwhile
    // backs off rather than reaping a session the disband will reap.
    const failures = await act(async () =>
      agentRun.close({ kind: "agent", workspace: refOf("ws-2"), paneId: "pane-9" }),
    );
    expect(failures).toEqual([]);
    expect(pty.closed).toEqual([]);
    expect(paneIds("ws-2")).toEqual(["pane-9"]);

    await act(async () => {
      publish(null);
      await disbanding;
    });
    expect(pty.closed).toEqual(["pane-9"]);
    expect(paneIds("ws-2")).toEqual([]);
    expect(teamIds("ws-2")).toEqual([]);
  });

  it("a stale confirmation — the workspace slot reused — touches nothing", async () => {
    const stale = refOf("ws-1");
    act(() => deck.closeWorkspace("ws-1"));
    seed();
    expect(refOf("ws-1").instance).not.toBe(stale.instance);

    const failures = await act(async () =>
      agentRun.close({ kind: "agent", workspace: stale, paneId: "pane-1" }),
    );
    expect(failures).toEqual([]);
    expect(paneIds("ws-1")).toEqual(["pane-1", "pane-2"]);
    expect(pty.closed).toEqual([]);
  });
});

describe("agent orchestrator —disbanding a team", () => {
  const disband = (teamId: string, deleteWorktrees: boolean, worktrees = [] as typeof target[], wsId = "ws-1") =>
    agentRun.close({ kind: "team", workspace: refOf(wsId), teamId, deleteWorktrees, worktrees });

  it("ends every member, removes the team, and forgets its fork step", async () => {
    await act(async () => disband("team-2", false));
    expect(paneIds("ws-1")).toEqual(["pane-1"]);
    expect(teamIds("ws-1")).toEqual(["team-1"]);
    expect(pty.closed).toEqual(["pane-2"]);
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-2");
    expect(lifecycle.retire).toHaveBeenCalledWith("pane-2");
    // No Retry is coming for a team that is gone.
    expect(steps.clear).toHaveBeenCalledWith("team-2");
    expect(discards).toEqual([]);
  });

  it("deletes the team's worktree once when the box was ticked, however many sources name it", async () => {
    // The dialog's list, the live team, and the create's ticket all name
    // /wt/2 — one directory, one removal.
    published.set("team-2", Promise.resolve(target));
    await act(async () => disband("team-2", true, [target]));
    expect(discards).toEqual([[target]]);
  });

  it("deletes nothing when the box was left unticked — and still consumes the ticket", async () => {
    published.set("team-2", Promise.resolve(target));
    await act(async () => disband("team-2", false));
    expect(discards).toEqual([]);
    expect(published.has("team-2")).toBe(false);
  });

  it("reports back what it could not delete, rather than swallowing it", async () => {
    setDiscardFailures(["kd/ws/2: still in use"]);
    const failures = await act(async () => disband("team-2", true, [target]));
    expect(failures).toEqual(["kd/ws/2: still in use"]);
  });

  it("never reaches the worktree runner when nothing was asked for", async () => {
    const failures = await act(async () => disband("team-2", false));
    expect(failures).toEqual([]);
    expect(discards).toEqual([]);
  });

  it("a team on the workspace root disbands without deleting, whatever the list says", async () => {
    // The root is never a deletion target — structurally, not by the
    // dialog's grace: a list that names it is ignored.
    await act(async () =>
      disband("team-1", true, [{ repo: "/repo", path: "/repo", branch: "main" }]),
    );
    expect(discards).toEqual([]);
    expect(teamIds("ws-1")).toEqual(["team-2"]);
    expect(paneIds("ws-1")).toEqual(["pane-2"]);
    expect(pty.closed).toEqual(["pane-1"]);
  });

  it("deletes what a still-running create put on disk, without waiting for the rest of it", async () => {
    // A team mid-create has no directory, so it contributes no ordinary
    // target. The create publishes the directory the moment `git worktree
    // add` returns, which is what lets this close name it — and lets it
    // settle even though the create's setup step is stuck.
    creating();
    published.set("team-9", Promise.resolve(made));
    const failures = await act(async () => disband("team-9", true, [], "ws-2"));
    expect(failures).toEqual([]);
    expect(discards).toEqual([[made]]);
    expect(teamIds("ws-2")).toEqual([]);
    expect(paneIds("ws-2")).toEqual([]);
  });

  it("removes what a create landed while the dialog was still open", async () => {
    // The dialog's list is frozen when it opens. A create finishing while
    // the user reads it turns a team the dialog called "still being created"
    // into one that owns a worktree — which that frozen list will never
    // mention. Deciding from the live deck is what covers it.
    creating();
    act(() =>
      deck.resolveTeamProvisioning("ws-2", "team-9", { cwd: "/wt/late", branch: "kd/ws/late" }),
    );
    // Exactly what the dialog offered when it opened: nothing.
    await act(async () => disband("team-9", true, [], "ws-2"));
    expect(discards).toEqual([[{ repo: "/repo", path: "/wt/late", branch: "kd/ws/late" }]]);
  });

  it("a disband confirmed while the create is still out waits for it, then removes what it made — once", async () => {
    creating();
    const publish = pendingTicket("team-9");
    let disbanding!: Promise<string[]>;
    act(() => {
      disbanding = disband("team-9", true, [], "ws-2");
    });
    await act(async () => {});
    // Captured: the fork step is forgotten at once, the team stays in the
    // deck until its create answers, and nothing is removed yet.
    expect(steps.clear).toHaveBeenCalledWith("team-9");
    expect(teamIds("ws-2")).toEqual(["team-9"]);
    expect(discards).toEqual([]);

    await act(async () => {
      publish(made);
      await disbanding;
    });
    expect(discards).toEqual([[made]]);
    expect(teamIds("ws-2")).toEqual([]);
    expect(pty.closed).toEqual(["pane-9"]);
  });

  it("two confirmations for one team remove once and reap each session once", async () => {
    creating();
    const publish = pendingTicket("team-9");
    let first!: Promise<string[]>;
    let second!: Promise<string[]>;
    act(() => {
      first = disband("team-9", true, [], "ws-2");
      second = disband("team-9", true, [], "ws-2");
    });
    await act(async () => {
      publish(made);
      await Promise.all([first, second]);
    });
    expect(discards).toEqual([[made]]);
    expect(pty.closed).toEqual(["pane-9"]);
    expect(teamIds("ws-2")).toEqual([]);
  });
});

describe("agent orchestrator —closing a workspace", () => {
  const closeWorkspace = (deleteWorktrees: boolean, worktrees = [] as typeof target[], wsId = "ws-1") =>
    agentRun.close({ kind: "workspace", workspace: refOf(wsId), deleteWorktrees, worktrees });

  it("ends every pane it held and removes the workspace", async () => {
    await act(async () => closeWorkspace(false));
    expect(deck.workspaces).toHaveLength(0);
    expect(pty.closed).toEqual(["pane-1", "pane-2"]);
    expect(vi.mocked(dropPaneSpawnSpec).mock.calls).toEqual([["pane-1"], ["pane-2"]]);
    expect(steps.clear.mock.calls).toEqual([["team-1"], ["team-2"]]);
  });

  it("removes worktrees only AFTER the processes are reaped", async () => {
    // A directory that is still some agent's cwd cannot be removed.
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closing!: Promise<string[]>;
    act(() => {
      closing = closeWorkspace(true, [target]);
    });
    await act(async () => {});
    expect(discards).toEqual([]);
    await act(async () => {
      release();
      await closing;
    });
    expect(discards).toEqual([[target]]);
  });

  it("still reaps a pane whose reap REJECTS, and the rest with it", async () => {
    // One process refusing to die must not strand the others, nor leave the
    // worktree removal waiting on a promise that never settles.
    pty.hold = Promise.reject(new Error("pty gone"));
    const failures = await act(async () => closeWorkspace(true, [target]));
    expect(failures).toEqual([]);
    expect(discards).toEqual([[target]]);
  });

  it("a disband that got there first keeps its team's decision — the later workspace close deletes nothing of it", async () => {
    let disbanding!: Promise<string[]>;
    let closing!: Promise<string[]>;
    act(() => {
      disbanding = agentRun.close({
        kind: "team",
        workspace: refOf("ws-1"),
        teamId: "team-2",
        deleteWorktrees: false,
        worktrees: [],
      });
      closing = closeWorkspace(true, [target]);
    });
    await act(async () => Promise.all([disbanding, closing]));
    // The disband said "keep"; the workspace close lost that team's
    // capture and left its worktree alone, whatever its own box said.
    expect(discards).toEqual([]);
    expect(deck.workspaces).toHaveLength(0);
    expect([...pty.closed].sort()).toEqual(["pane-1", "pane-2"]);
  });

  it("a workspace close that got there first leaves the later disband nothing to do", async () => {
    let closing!: Promise<string[]>;
    let disbanding!: Promise<string[]>;
    act(() => {
      closing = closeWorkspace(true, [target]);
      disbanding = agentRun.close({
        kind: "team",
        workspace: refOf("ws-1"),
        teamId: "team-2",
        deleteWorktrees: true,
        worktrees: [target],
      });
    });
    await act(async () => Promise.all([closing, disbanding]));
    expect(discards).toEqual([[target]]);
    expect(deck.workspaces).toHaveLength(0);
    expect([...pty.closed].sort()).toEqual(["pane-1", "pane-2"]);
  });

  it("a second confirmation of the same workspace close does nothing", async () => {
    creating();
    const publish = pendingTicket("team-9");
    let first!: Promise<string[]>;
    let second!: Promise<string[]>;
    act(() => {
      first = closeWorkspace(true, [], "ws-2");
      second = closeWorkspace(true, [], "ws-2");
    });
    await act(async () => {
      publish(made);
      await Promise.all([first, second]);
    });
    expect(discards).toEqual([[made]]);
    expect(pty.closed).toEqual(["pane-9"]);
    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1"]);
  });

  it("a stale confirmation — the slot reused — leaves the new workspace alone", async () => {
    const stale = refOf("ws-1");
    act(() => deck.closeWorkspace("ws-1"));
    seed();
    const failures = await act(async () =>
      agentRun.close({ kind: "workspace", workspace: stale, deleteWorktrees: true, worktrees: [target] }),
    );
    expect(failures).toEqual([]);
    expect(deck.workspaces.map((ws) => ws.id)).toEqual(["ws-1"]);
    expect(paneIds("ws-1")).toEqual(["pane-1", "pane-2"]);
    expect(pty.closed).toEqual([]);
    expect(discards).toEqual([]);
  });
});
