// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  settle,
  steps,
  lifecycle,
} from "./testSupport";
import type {
  Pane,
  SuspendOutcome,
} from "./testSupport";

describe("agent orchestrator —suspending an agent", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    lifecycle.retire.mockClear();
    ipc.probeWorktree.mockReset().mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    catalog.moveSuspendedToTray = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const seed = (over: Partial<Pane> = {}) =>
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "codex",
            cwd: "/worktree",
            branch: "feature/x",
            session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
            ...over,
          },
        ],
      }),
    );

  const pane = () => deck.workspaces[0].panes[0];

  it("stops the process but keeps the pane, its worktree and its resume key", async () => {
    seed();
    await act(async () => agentRun.suspend("ws-1", "pane-1"));

    expect(pty.closed).toEqual(["pane-1"]);
    expect(pane()).toEqual({
      id: "pane-1",
      agentType: "codex",
      cwd: "/worktree",
      branch: "feature/x",
      session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
      idle: { reason: "suspended", at: expect.any(String) },
    });
    expect(deck.viewByWs["ws-1"]?.suspendedTray).toBeUndefined();
  });

  it("atomically moves the stopped pane to the existing tray when configured", async () => {
    catalog.moveSuspendedToTray = true;
    seed();

    await act(async () => agentRun.suspend("ws-1", "pane-1"));

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(deck.viewByWs["ws-1"]?.suspendedTray).toEqual(["pane-1"]);
  });

  it("marks the pane idle BEFORE reaping, so no sweep can respawn it mid-flight", async () => {
    seed();
    // A teardown that never finishes: the pane must ALREADY be out of the run
    // sweep's reach while its process is still going down. Reaping first would
    // leave a live, plan-less pane across that await — long enough for the
    // sweep to hand it a fresh plan and a NEW process, which this suspend
    // would then orphan (unmounting a view never kills a session).
    pty.hold = new Promise<void>(() => {});

    await act(async () => {
      void agentRun.suspend("ws-1", "pane-1");
    });

    expect(pty.closed).toEqual(["pane-1"]);
    expect(pane().idle).toEqual({ reason: "suspended", at: expect.any(String) });
  });

  it("revokes the bridge token and drops the pane's usage", async () => {
    seed();
    await act(async () => agentRun.suspend("ws-1", "pane-1"));
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(lifecycle.retire).toHaveBeenCalledWith("pane-1");
  });

  it("reports the in-flight refusal apart from every other one", async () => {
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let first!: Promise<SuspendOutcome>;
    act(() => {
      first = agentRun.suspend("ws-1", "pane-1");
    });
    // Distinct from "stopped": the pane is not down yet, someone is taking
    // it down.
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "in-flight",
    );
    act(() => release());
    expect(await act(async () => first)).toBe("suspended");
    expect(pty.closed).toEqual(["pane-1"]);
  });

  it("names the reason it refuses, so every surface can say the same thing", async () => {
    // A bare `false` forced each caller to guess, and one guessed wrong: it
    // told a remote pane's user their running agent had no session to stop.
    seed({ provisioning: { repo: "/repo", workspace: "ws", index: 1 } });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "provisioning",
    );
    expect(await act(async () => agentRun.suspend("ws-1", "nope"))).toBe("gone");
    expect(await act(async () => agentRun.suspend("nope", "pane-1"))).toBe(
      "gone",
    );
    expect(pty.closed).toEqual([]);
    expect(pane().idle).toBeUndefined();
  });

  it("refuses a pane that is ALREADY stopped, whatever put it there", async () => {
    // Without this a second gesture re-runs the whole teardown on a pane with
    // no process — and, for a suspended one, restamps its card.
    seed({ idle: { reason: "suspended", at: "2026-07-25T08:00:00.000Z" } });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "stopped",
    );
    expect(pty.closed).toEqual([]);
    expect(vi.mocked(dropPaneSpawnSpec)).not.toHaveBeenCalled();
    expect(pane().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T08:00:00.000Z",
    });
  });

  it("refuses a REMOTE pane BY NAME — its session lives on the server", async () => {
    seed({ remoteEndpoint: "ws://vps:4500" });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "remote",
    );
    expect(pty.closed).toEqual([]);
    expect(pane().idle).toBeUndefined();
  });

  it("refuses a pane the SWEEP found stuck on a gone folder", async () => {
    // It has no process and is going nowhere until someone relocates it; its
    // tile is already dimmed and its tray chip already carries the stopped
    // marker. This gesture was the last surface still treating it as running,
    // and taking it would write a durable `suspended` stamp over a pane whose
    // real problem is a missing directory. The verdict comes from the sweep
    // itself — the gesture and the sweep now share one owner.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    seed({ idle: { reason: "waking", origin: "restore" } });
    await settle();
    expect(agentRun.blocked).toEqual({ "pane-1": "/worktree" });

    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "stopped",
    );
    expect(pty.closed).toEqual([]);
  });

  it("still suspends a pane that is merely RISING — that cancels the wake", async () => {
    // The mirror of the case above: without a block, a pane on its way up is
    // a live target. Panes wait in `waking` for as long as their probe takes,
    // and refusing every idle pane made them unparkable in that window.
    seed({ idle: { reason: "waking", origin: "restore" } });
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "suspended",
    );
    expect(pty.closed).toEqual(["pane-1"]);
  });

  it("survives its workspace closing mid-reap, and releases the pane afterwards", async () => {
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first!: Promise<SuspendOutcome>;
    act(() => {
      first = agentRun.suspend("ws-1", "pane-1");
    });
    act(() => deck.closeWorkspace("ws-1"));
    // Resolves rather than throwing on the vanished pane…
    expect(
      await act(async () => {
        release();
        return first;
      }),
    ).toBe("suspended");
    expect(deck.workspaces).toHaveLength(0);

    // …and the guard is released, so the id is usable again. A leaked entry
    // would make that pane unsuspendable for the rest of the session.
    pty.reset();
    seed();
    expect(await act(async () => agentRun.suspend("ws-1", "pane-1"))).toBe(
      "suspended",
    );
    expect(pty.closed).toEqual(["pane-1"]);
  });
});

describe("agent orchestrator —closing panes and workspaces", () => {
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
    act(() =>
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          { id: "pane-1", agentType: "claude" },
          { id: "pane-2", agentType: "claude", cwd: "/wt/2", branch: "kd/ws/2" },
        ],
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    published.clear();
  });

  const target = { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" };

  it("takes one pane out of the deck and ends exactly its process", async () => {
    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-2"]);
    expect(pty.closed).toEqual(["pane-1"]);
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(lifecycle.retire).toHaveBeenCalledWith("pane-1");
    // An abandoned fork card's post-provision step goes too: no Retry is
    // coming for a pane that is gone.
    expect(steps.clear).toHaveBeenCalledWith("pane-1");
  });

  it("closing a workspace ends every pane it held", async () => {
    await act(async () =>
      agentRun.close({
        kind: "workspace",
        wsId: "ws-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(deck.workspaces).toHaveLength(0);
    expect(pty.closed).toEqual(["pane-1", "pane-2"]);
    expect(vi.mocked(dropPaneSpawnSpec).mock.calls).toEqual([
      ["pane-1"],
      ["pane-2"],
    ]);
  });

  it("revokes the bridge token BEFORE the reducer forgets the pane", async () => {
    // The reverse of a suspend's order, and deliberately: a reporter still in
    // flight — or a later pane reusing the id — must not be able to write.
    const order: string[] = [];
    vi.mocked(dropPaneSpawnSpec).mockImplementationOnce(() => {
      order.push(`revoked:${deck.workspaces[0].panes.length}`);
    });
    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(order).toEqual(["revoked:2"]);
  });

  it("removes worktrees only AFTER the processes are reaped", async () => {
    // A directory that is still some agent's cwd cannot be removed.
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closing!: Promise<string[]>;
    act(() => {
      closing = agentRun.close({
        kind: "workspace",
        wsId: "ws-1",
        deleteWorktrees: true,
        worktrees: [target],
      });
    });
    expect(discards).toEqual([]);
    await act(async () => {
      release();
      await closing;
    });
    expect(discards).toEqual([[target]]);
  });

  it("reports back what it could not delete, rather than swallowing it", async () => {
    setDiscardFailures(["kd/ws/2: still in use"]);
    const failures = await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-2",
        deleteWorktrees: true,
        worktrees: [target],
      }),
    );
    expect(failures).toEqual(["kd/ws/2: still in use"]);
  });

  it("never reaches the worktree runner when nothing was asked for", async () => {
    const failures = await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-2",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(failures).toEqual([]);
    expect(discards).toEqual([]);
  });

  it("deletes what a still-running create put on disk, without waiting for the rest of it", async () => {
    // A pane mid-create has no cwd, so it contributes no ordinary target. The
    // create publishes the directory the moment `git worktree add` returns,
    // which is what lets this close name it — and lets it settle even though
    // the create's setup step is stuck in the session slot about to be reaped.
    const made = { repo: "/repo", path: "/wt/9", branch: "kd/ws/9" };
    published.set("pane-1", Promise.resolve(made));

    const failures = await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: true,
        worktrees: [],
      }),
    );

    expect(failures).toEqual([]);
    expect(discards).toEqual([[made]]);
  });

  it("removes what a create landed while the dialog was still open", async () => {
    // The dialog's list is frozen when it opens. A create finishing while the
    // user reads it turns a pane the dialog called "still being created" into
    // one that owns a worktree — which that frozen list will never mention.
    // Deciding from the live deck is what covers it.
    act(() =>
      deck.createWorkspace({
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/repo",
        worktreeBaseDir: "/wt",
        panes: [
          {
            id: "pane-9",
            agentType: "claude",
            provisioning: { repo: "/repo", workspace: "two", index: 1 },
          },
        ],
      }),
    );
    // …the create lands while the confirm dialog is up.
    act(() =>
      deck.resolvePaneProvisioning("ws-2", "pane-9", {
        cwd: "/wt/late",
        branch: "kd/ws/late",
      }),
    );
    expect(deck.workspaces[1].panes[0].cwd).toBe("/wt/late");

    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-2",
        paneId: "pane-9",
        deleteWorktrees: true,
        // Exactly what the dialog offered when it opened: nothing.
        worktrees: [],
      }),
    );

    expect(discards).toEqual([
      [{ repo: "/repo", path: "/wt/late", branch: "kd/ws/late" }],
    ]);
  });

  it("deletes nothing when the box was left unticked", async () => {
    published.set(
      "pane-1",
      Promise.resolve({ repo: "/repo", path: "/wt/9", branch: "kd/ws/9" }),
    );
    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-1",
        deleteWorktrees: false,
        worktrees: [],
      }),
    );
    expect(discards).toEqual([]);
    // Consumed all the same, so no published entry is left behind.
    expect(published.has("pane-1")).toBe(false);
  });

  it("names one worktree once, however many sources mention it", async () => {
    const target = { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" };
    published.set("pane-2", Promise.resolve(target));

    await act(async () =>
      agentRun.close({
        kind: "agent",
        wsId: "ws-1",
        paneId: "pane-2",
        deleteWorktrees: true,
        // pane-2 already owns /wt/2, so the deck names it too.
        worktrees: [target],
      }),
    );

    expect(discards).toEqual([[target]]);
  });

  it("still reaps a pane whose reap REJECTS, and the rest with it", async () => {
    // One process refusing to die must not strand the others, nor leave the
    // worktree removal waiting on a promise that never settles.
    pty.hold = Promise.reject(new Error("pty gone"));
    const failures = await act(async () =>
      agentRun.close({
        kind: "workspace",
        wsId: "ws-1",
        deleteWorktrees: true,
        worktrees: [target],
      }),
    );
    expect(failures).toEqual([]);
    expect(discards).toEqual([[target]]);
  });
});
