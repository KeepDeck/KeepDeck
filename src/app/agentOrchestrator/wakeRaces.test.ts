// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Probe,
  agentRun,
  buildResumeSpec,
  catalog,
  createWorkspaceInstance,
  deck,
  dropPaneSpawnSpec,
  emptyJournal,
  gate,
  ipc,
  peekPaneSpawnSpec,
  pty,
  resetPaneSpawnSpecs,
  restored,
  settle,
} from "./testSupport";
import type {
  DeckState,
  PaneIdle,
  ResumeRequest,
} from "./testSupport";

describe("agent orchestrator —a request that lands mid-flight", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    // This block asserts CALL HISTORY on the drop; without a clear it would
    // be satisfied by an earlier describe's calls for the same pane id, and
    // the branch it targets could stop dropping without anything failing.
    vi.mocked(dropPaneSpawnSpec).mockClear();
    gate.build = null;
    ipc.probeWorktree.mockReset();
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];
  const origins = () =>
    vi.mocked(buildResumeSpec).mock.calls.map((call) => call[5]);

  /** A probe held open, so a gesture can land while the wake is in flight. */
  const heldProbe = () => {
    let release!: () => void;
    ipc.probeWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exists: true, isWorktree: false, empty: false, branch: null });
        }),
    );
    return () => release();
  };

  it("serves a resume asked for DURING the probe as the user's, not as a boot restore", async () => {
    // The sweep holds the pane in its in-flight set, so the request starts no
    // second attempt — the one already running has to notice it. Judging by
    // the origin captured when the probe went out is how a resume the user
    // asked for by name came up as a fresh conversation instead.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    // The pane is mid-probe; ask for it by name (the `agent.resume` path).
    let asked: ResumeRequest | undefined;
    act(() => {
      asked = agentRun.resume("ws-1", "pane-1");
    });
    expect(asked).toBe("resuming");
    release();
    await settle();

    expect(origins()).toEqual(["manual"]);
    expect(pane().idle).toBeUndefined();
  });

  it("clears the failure flag when a BOOT restore's plan build throws", async () => {
    // The build that throws also marks the pane as plan-failed inside
    // spawnSpecs, so waking it without dropping that flag lands it on the
    // "Couldn't start this agent" tile — while the code here says a restore
    // that fails "wakes fresh". The manual branch drops the flag and says
    // why; the restore branch has to do the same or it doesn't wake fresh at
    // all, it wakes broken.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    vi.mocked(buildResumeSpec).mockRejectedValueOnce(new Error("hook blew up"));
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await settle();

    expect(pane().idle).toBeUndefined(); // woken, as documented
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    // Nobody asked for this wake, so nothing is reported on the card.
    expect(agentRun.wakeFailed).toEqual({});
  });

  it("sees a request dispatched outside a React event", async () => {
    // `agent.resume` reached from MCP, the plugin bridge or a Tauri callback
    // dispatches from a promise continuation rather than a React event, so
    // the store holds the request before any render carries it. The sweep
    // reads the origin through the hook's deck, and this pins that the two
    // cannot come apart: if they ever did, the user's named resume would be
    // served as a boot restore — the one origin allowed to become a new
    // conversation. Deliberately NOT wrapped in act(): the un-flushed
    // dispatch is the point.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    deck.requestPaneWake("ws-1", "pane-1");
    release();
    await settle();

    expect(origins()).toEqual(["manual"]);
  });

  it("re-stamps a plan already built as a restore when the request arrives mid-BUILD", async () => {
    // The origin is baked into the cached plan — it is what arms the one-shot
    // fall back to a fresh conversation. A plan built as a restore therefore
    // cannot serve a resume the user asked for.
    // Held open, but still caching a plan the way a real build does — the
    // re-stamp has to have something to re-stamp.
    let releaseBuild!: () => void;
    gate.build = new Promise<void>((resolve) => (releaseBuild = resolve));
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => {
      agentRun.resume("ws-1", "pane-1");
    });
    releaseBuild();
    await settle();

    // Built ONCE. The origin is a field of the assembled plan — it never
    // reaches the plugin's `resume.plan` hook — so re-running that hook to
    // change it would run a third party's code twice for something it cannot
    // see. The cached plan is re-stamped instead.
    expect(origins()).toEqual(["restore"]);
    expect(peekPaneSpawnSpec("pane-1")?.resumeOrigin).toBe("manual");
    expect(pane().idle).toBeUndefined();
  });

  it("drops the outcome of a wake the user CANCELLED mid-probe", async () => {
    // Suspending a rising pane cancels the wake. Building a plan for it
    // afterwards would hand a stopped pane a live resume spec, and reporting
    // the attempt would explain a failure nobody is waiting on.
    const release = heldProbe();
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => deck.suspendPane("ws-1", "pane-1"));
    release();
    await settle();

    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(origins()).toEqual([]); // no plan built for a cancelled wake
    expect(agentRun.wakeFailed).toEqual({});
  });

  it("does not BLOCK a pane the user stopped while its folder was being probed", async () => {
    // The gone-folder verdict arrives without going through `wake` at all, so
    // it needs the same guard: marking the pane blocked would leave the
    // suspended card explaining a directory the user never asked about, and a
    // blocked pane is skipped by the sweep until something clears it.
    let release!: () => void;
    ipc.probeWorktree.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ exists: false, isWorktree: false, empty: false, branch: null });
        }),
    );
    act(() => deck.hydrate(restored({ session: { id: "s-1", boundAt: "t" } })));
    await act(async () => {});

    act(() => deck.suspendPane("ws-1", "pane-1"));
    release();
    await settle();

    expect(agentRun.blocked).toEqual({});
    expect(pane().idle).toMatchObject({ reason: "suspended" });
  });
});

describe("agent orchestrator —a pane asked for by name in another workspace", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    // Reset, not clear: `mockClear` leaves an unconsumed `…Once` queue in
    // place, which then answers the FIRST build of the next test.
    vi.mocked(buildResumeSpec).mockReset();
    gate.build = null;
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
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** Two workspaces, `ws-1` active; the pane to resume lives in `ws-2`. */
  const twoWorkspaces = (idle: PaneIdle): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "one",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude" }],
      },
      {
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "two",
        cwd: "/other",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-2",
            agentType: "claude",
            idle,
            session: { id: "s-2", boundAt: "t" },
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const background = () => deck.workspaces[1].panes[0];

  it("is served where it stands, instead of waiting for a workspace switch", async () => {
    // `agent.resume` takes a workspace argument precisely so it can reach a
    // pane that isn't on screen. Marking such a pane and then never sweeping
    // it left it neither running nor durably stopped: the suspend is dropped
    // from state (and from disk, it is the durable half) while nothing acts
    // on the request, so quitting before switching lost the suspend.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    expect(background().idle).toMatchObject({ reason: "suspended" });

    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();

    expect(background().idle).toBeUndefined();
    expect(peekPaneSpawnSpec("pane-2")?.args).toEqual(["--resume", "s-2"]);
  });

  it("actually STARTS the off-screen pane it says it is resuming", async () => {
    // The whole point of the workspace argument. The wake cleared the pane's
    // durable `suspended` stamp and the next pass then judged it by the
    // unopened-workspace economy — which the request is exempt from — so the
    // pane was left neither running nor durably stopped. Quitting before
    // visiting ws-2 persisted it as a plain running pane, and the next launch
    // started the agent the user had parked.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    pty.acquired = [];

    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();

    expect(background().idle).toBeUndefined();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-2"]);
    expect(agentRun.specs["pane-2"]).toBeDefined();
  });

  it("stops owing a start once the pane has a process", async () => {
    // The debt exempts a pane from the unopened-workspace economy. Left
    // behind, it would keep exempting that pane for the session — respawning
    // it on every exit in a workspace nobody has opened.
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();
    expect(pty.acquired.map((a) => a.paneId)).toContain("pane-2");

    // Its process dies. Nothing asked for it again, so nothing restarts it.
    pty.acquired = [];
    act(() => {
      pty.live.delete("pane-2");
      pty.notify();
    });
    await settle();
    expect(pty.acquired).toEqual([]);
  });

  it("stops owing a start when the attempt gives up", async () => {
    // A refused wake is not a start still owed. Keeping the debt would exempt
    // the pane from the economy for the rest of the session.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() =>
      deck.hydrate(twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" })),
    );
    await settle();
    act(() => {
      agentRun.resume("ws-2", "pane-2");
    });
    await settle();
    expect(agentRun.blocked["pane-2"]).toBe("/other");
    // Put back where it came from, not left rising.
    expect(background().idle).toMatchObject({ reason: "suspended" });

    // The folder comes back. Nothing has asked for the pane since the refusal,
    // so a plain sweep leaves it alone — the debt did not survive.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    pty.acquired = [];
    act(() => deck.renameWorkspace("ws-2", "two again"));
    await settle();
    expect(pty.acquired).toEqual([]);

    // Asking again re-owes it, and the pane starts even off screen.
    act(() => {
      agentRun.startFresh("ws-2", "pane-2");
    });
    await settle();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-2"]);
  });

  it("refuses a pane no plugin can start, instead of stranding it", async () => {
    // The sweep skips a pane whose agent no plugin provides, so marking it
    // `waking` puts it somewhere nothing will ever settle: the durable
    // `suspended` stamp is gone from state (and from the next save), the
    // sweep won't touch it, and every "is this running" answer flips to yes
    // for an agent that cannot start. Refusing keeps the pane exactly as it
    // was, and the caller is told why.
    act(() =>
      deck.hydrate(
        twoWorkspaces({ reason: "suspended", at: "2026-07-25T09:00:00.000Z" }),
      ),
    );
    await settle();
    act(() => {
      deck.workspaces[1].panes[0].agentType = "retired-cli";
    });

    expect(agentRun.resume("ws-2", "pane-2")).toBe("unavailable");
    expect(background().idle).toEqual({
      reason: "suspended",
      at: "2026-07-25T09:00:00.000Z",
    });
  });

  it("still leaves a RESTORED pane in a background workspace alone", async () => {
    // The lazy-revive policy is about panes that rise by themselves: waking a
    // whole background workspace at launch is what it exists to prevent.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();

    expect(background().idle).toEqual({ reason: "waking", origin: "restore" });
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
  });
});
