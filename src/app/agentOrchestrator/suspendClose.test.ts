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
  dropPaneSpawnSpec,
  ipc,
  pty,
  resetPaneSpawnSpecs,
  settle,
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
            location: { kind: "attached", cwd: "/worktree", branch: "feature/x" },
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
      location: { kind: "attached", cwd: "/worktree", branch: "feature/x" },
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
    // A create in flight has no session yet, so the seed's goes.
    seed({
      location: {
        kind: "provisioning",
        intent: { repo: "/repo", path: "/wt/a", index: 1 },
      },
      session: undefined,
    });
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
    seed({ location: { kind: "remote", endpoint: "ws://vps:4500" } });
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
