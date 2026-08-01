// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Probe,
  agentRun,
  buildResumeSpec,
  catalog,
  clearPanePlanError,
  createWorkspaceInstance,
  ctx,
  deck,
  dropPaneSpawnSpec,
  gate,
  ipc,
  peekPaneSpawnSpec,
  plans,
  pty,
  resetPaneSpawnSpecs,
  settle,
  skillsAsked,
  telemetry,
} from "./agentOrchestrator.testSupport";
import type {
  RestartOutcome,
} from "./agentOrchestrator.testSupport";

describe("agent orchestrator —restarting an exited agent", () => {
  let root: Root;
  beforeEach(() => {
    resetPaneSpawnSpecs();
    vi.mocked(buildResumeSpec).mockReset();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    vi.mocked(clearPanePlanError).mockClear();
    telemetry.retirePaneTelemetry.mockClear();
    skillsAsked.mockClear();
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
  const seed = (sessionId: string | null = "session-old") =>
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
            branch: "feature/restart",
            yolo: true,
            ...(sessionId
              ? { session: { id: sessionId, boundAt: "2026-07-11T00:00:00Z" } }
              : {}),
          },
        ],
      }),
    );
  const pane = () => deck.workspaces[0].panes[0];
  const epoch = () => agentRun.epochs["pane-1"];
  /** A second workspace to switch to, leaving ws-1 off screen. */
  const otherWorkspace = () => ({
    id: "ws-2",
    instance: createWorkspaceInstance(),
    name: "two",
    cwd: "/other",
    worktreeBaseDir: null,
    panes: [],
  });
  it("resumes the exact binding with a new plan and keeps the pane's facts", async () => {
    seed();
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));
    expect(vi.mocked(buildResumeSpec)).toHaveBeenCalledWith(
      expect.anything(),
      "codex",
      {
        paneId: "pane-1",
        workspace: { id: "ws-1", instance: deck.workspaces[0].instance },
        cwd: "/worktree",
        branch: "feature/restart",
        yolo: true,
        stagedSkills: expect.any(Function),
      },
      ctx,
      "session-old",
      "manual",
    );
    expect(pty.closed).toEqual(["pane-1"]);
    expect(telemetry.retirePaneTelemetry).toHaveBeenCalledWith("pane-1");
    expect(epoch()).toBe(1);
    expect(pane()).toMatchObject({
      cwd: "/worktree",
      branch: "feature/restart",
      session: { id: "session-old" },
    });
    const calls = vi.mocked(buildResumeSpec).mock.calls;
    await calls[calls.length - 1][2].stagedSkills?.();
    expect(skillsAsked).toHaveBeenCalledWith(
      { id: "ws-1", instance: deck.workspaces[0].instance },
      undefined,
    );
  });
  it("starts fresh only on click, clearing the binding but keeping the worktree", async () => {
    seed();
    await act(async () => agentRun.restart("ws-1", "pane-1", "fresh"));
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(pty.closed).toEqual(["pane-1"]);
    expect(telemetry.retirePaneTelemetry).toHaveBeenCalledWith("pane-1");
    expect(pane()).toMatchObject({
      cwd: "/worktree",
      branch: "feature/restart",
    });
    expect(pane().session).toBeUndefined();
    expect(epoch()).toBe(1);
  });
  it("a suspend landing mid-restart keeps its binding — neither gesture blocks the other", async () => {
    // Suspending and restarting hold SEPARATE guards, so ⇧⌘W slips inside the
    // restart's reap. The pane is parked by the time the restart resumes, and
    // its binding is exactly what its resume needs: wiping it would turn the
    // user's suspend into a new conversation.
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let restarting!: Promise<unknown>;
    act(() => {
      restarting = agentRun.restart("ws-1", "pane-1", "fresh");
    });
    act(() => deck.suspendPane("ws-1", "pane-1"));
    await act(async () => {
      release();
      await restarting;
    });
    expect(pane().session).toEqual({
      id: "session-old",
      boundAt: "2026-07-11T00:00:00Z",
    });
    expect(pane().idle).toMatchObject({ reason: "suspended" });
    // No remount either: the pane is stopped, there is nothing to mount.
    expect(epoch()).toBeUndefined();
  });
  it("a suspend landing mid-RESUME leaves the pane stopped, not remounted", async () => {
    // Every field the resume path compares survives a suspend untouched, so
    // the idle marker is the only thing that says the user changed their mind.
    // Without that check the epoch bump would remount the pane the suspend
    // just stopped — a stopped card that spawns a terminal on its own.
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let restarting!: Promise<unknown>;
    act(() => {
      restarting = agentRun.restart("ws-1", "pane-1", "resume");
    });
    // The plan is built before the reap, so let it settle, then suspend.
    await act(async () => {});
    act(() => deck.suspendPane("ws-1", "pane-1"));
    await act(async () => {
      release();
      await restarting;
    });
    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(pane().session).toEqual({
      id: "session-old",
      boundAt: "2026-07-11T00:00:00Z",
    });
    expect(epoch()).toBeUndefined();
  });
  it("falls back to fresh safely when resume was asked for without a binding", async () => {
    seed(null);
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(pty.closed).toEqual(["pane-1"]);
    expect(epoch()).toBe(1);
  });
  it("restarts a REMOTE pane fresh even with a stale binding clinging to it", async () => {
    // Resuming it locally would drop the endpoint. The target's session id is
    // null for a remote pane, so the restart falls through to fresh.
    seed();
    act(() => {
      pane().remoteEndpoint = "ws://vps:4500";
    });
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    expect(pty.closed).toEqual(["pane-1"]);
    expect(epoch()).toBe(1);
  });
  it("coalesces repeated clicks while one restart is in flight", async () => {
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first!: Promise<unknown>;
    act(() => {
      first = agentRun.restart("ws-1", "pane-1", "fresh");
      void agentRun.restart("ws-1", "pane-1", "fresh");
    });
    expect(pty.closed).toEqual(["pane-1"]);
    await act(async () => {
      release();
      await first;
    });
    expect(epoch()).toBe(1);
  });
  it("does not resurrect a pane closed while its resume plan is building", async () => {
    seed();
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    act(() => deck.closeAgent("ws-1", "pane-1"));
    await act(async () => {
      release();
      await pending;
    });
    expect(pty.closed).toEqual([]);
    expect(peekPaneSpawnSpec("pane-1")).toBeUndefined();
    expect(epoch()).toBeUndefined();
  });
  it("keeps the pane exited when a manual resume plan cannot be prepared", async () => {
    seed();
    vi.mocked(buildResumeSpec).mockResolvedValueOnce(false);
    await expect(
      act(async () => agentRun.restart("ws-1", "pane-1", "resume")),
    ).rejects.toThrow("could not prepare a resume plan");
    expect(pty.closed).toEqual([]);
    expect(epoch()).toBeUndefined();
    expect(pane().session?.id).toBe("session-old");
  });
  it("revokes the retired process's token BEFORE building the replacement's plan", async () => {
    // A restart is only ever offered on a pane whose process has already ended
    // — the exit card is its one entry point — so the credential being dropped
    // belongs to a dead process. Building first would let the new plan inherit
    // it (the cache mints a fresh token only when no spec is present), and a
    // late bridge envelope, or a child that outlived the PTY, could then still
    // echo it and rebind this pane.
    seed();
    await settle();
    vi.mocked(dropPaneSpawnSpec).mockClear();
    vi.mocked(buildResumeSpec).mockClear();
    await act(async () => agentRun.restart("ws-1", "pane-1", "resume"));
    const dropped = vi.mocked(dropPaneSpawnSpec).mock.invocationCallOrder[0];
    const built = vi.mocked(buildResumeSpec).mock.invocationCallOrder[0];
    expect(dropped).toBeLessThan(built);
    expect(epoch()).toBe(1);
  });
  it("blames the suspend, not the agent, when one lands inside the build", async () => {
    // A real suspend drops the pane's spec, which retires this build's
    // generation by design, so the plan comes back unbuilt. Reading that as
    // "the agent could not prepare a plan" put a failure on the card of a pane
    // the user had just parked on purpose.
    seed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // What the real cache does when a suspend drops the spec mid-build: the
    // build loses its generation and reports that it cached nothing.
    vi.mocked(buildResumeSpec).mockImplementationOnce(async () => {
      await held;
      return false;
    });
    let pending!: Promise<RestartOutcome>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    act(() => {
      void agentRun.suspend("ws-1", "pane-1");
    });
    await act(async () => {
      release();
      await expect(pending).resolves.toBe("stopped");
    });
    expect(pane().idle).toMatchObject({ reason: "suspended" });
    expect(epoch()).toBeUndefined();
  });
  it("keeps the sweep off a pane a restart owns, even once it goes idle", async () => {
    // The guard used to sit inside the "should run and has no marker" branch,
    // so a suspend during the restart's awaits — which marks the pane idle —
    // dropped the pane straight through to the WAKE half. That half would
    // build a plan into the slot the restart is still using, and the restart's
    // continuation then reads it as its own failed build.
    seed();
    await settle();
    let release!: () => void;
    gate.build = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<RestartOutcome>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    // Suspended, then asked for back — the pane is now `waking`, which is the
    // wake half's entry condition.
    act(() => deck.suspendPane("ws-1", "pane-1"));
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    vi.mocked(buildResumeSpec).mockClear();
    await settle();
    // The sweep did NOT start a second build for the pane mid-restart.
    expect(vi.mocked(buildResumeSpec)).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await pending;
    });
  });
  it("mounts the prepared plan even if the pane moves under the reap, never a fresh one", async () => {
    // Past the reap the process is already gone, so standing down is not on
    // offer: the sweep sees a pane that should run with no process and would
    // build a FRESH plan for it — turning the resume the user named by hand
    // into a brand-new conversation whose reporter then overwrites the
    // binding. The prepared plan is mounted instead.
    //
    // The session change is forced here through the deck directly; production
    // can no longer produce it, because the token this restart revoked before
    // building is the one a late postback would have to echo. The test keeps
    // it as the belt to that braces.
    seed();
    await settle();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<RestartOutcome>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    // The plan is built before the reap, so let it settle first — this has to
    // land inside `sessions.close`, which is the window the pre-reap checks
    // cannot cover.
    await act(async () => {});
    act(() =>
      deck.setPaneSession("ws-1", "pane-1", {
        id: "session-new",
        boundAt: "2026-07-12T00:00:00Z",
      }),
    );
    await act(async () => {
      release();
      await expect(pending).resolves.toBe("restarted");
    });
    // The remount happened, and the plan behind it is still the manual resume
    // of the session that was asked for — not a fresh spawn.
    expect(epoch()).toBe(1);
    expect(peekPaneSpawnSpec("pane-1")).toMatchObject({
      resumeOrigin: "manual",
      resumeOf: "session-old",
    });
  });
  it("does not let the SWEEP spawn the process it is retiring", async () => {
    // Closing the session empties the slot, which reads to the sweep exactly
    // like a pane that should be started. Spawning there would race the
    // restart's own continuation, which then finishes against a process it
    // did not start — and its stand-down path revokes a LIVE process's bridge
    // token, silencing that agent's reports for the rest of its life.
    seed();
    await settle();
    pty.acquired = [];
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "resume");
    });
    await settle();
    expect(pty.acquired).toEqual([]);
    // …and once it is done, the sweep is told to look again.
    await act(async () => {
      release();
      await pending;
    });
    await settle();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-1"]);
  });
  it("says it stood down when a suspend beat it, instead of reporting success", async () => {
    // The card clears its "Restarting…" state on this answer. Reading a
    // resolved promise as a restart left it promising one that never came.
    seed();
    let release!: () => void;
    pty.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = agentRun.restart("ws-1", "pane-1", "fresh");
    });
    act(() => deck.suspendPane("ws-1", "pane-1"));
    let outcome: unknown;
    await act(async () => {
      release();
      outcome = await pending;
    });
    expect(outcome).toBe("stopped");
  });
  it("refuses a second click by name, and a pane that is gone", async () => {
    seed();
    pty.hold = new Promise<void>(() => {});
    act(() => {
      void agentRun.restart("ws-1", "pane-1", "fresh");
    });
    expect(await act(async () => agentRun.restart("ws-1", "pane-1", "fresh"))).toBe(
      "in-flight",
    );
    expect(await act(async () => agentRun.restart("ws-1", "nope", "fresh"))).toBe(
      "gone",
    );
  });
  it("retryPlanBuild drops the failure and the half-built plan, without a reap", async () => {
    seed();
    act(() => agentRun.retryPlanBuild("pane-1"));
    expect(vi.mocked(dropPaneSpawnSpec)).toHaveBeenCalledWith("pane-1");
    expect(vi.mocked(clearPanePlanError)).toHaveBeenCalledWith("pane-1");
    expect(epoch()).toBe(1);
    // No process was ever started for a failed-plan pane — nothing to close.
    expect(pty.closed).toEqual([]);
  });
  it("publishes a failed build as the error tile, and clears it on retry", async () => {
    // The tile is what a pane whose plan could not be built shows instead of
    // hanging on "Waking up…" forever, and the retry is the only way off it.
    seed();
    await settle();
    act(() => {
      plans.failed.add("pane-1");
      plans.notify();
    });
    expect([...agentRun.planFailed]).toEqual(["pane-1"]);
    act(() => agentRun.retryPlanBuild("pane-1"));
    await settle();
    expect([...agentRun.planFailed]).toEqual([]);
    expect(agentRun.specs["pane-1"]).toBeDefined();
  });
  it("answers what a restart DID, for every way it can end", async () => {
    // The card clears its spinner on any answer but "restarted", so a wrong
    // literal either strands it or clears it too early.
    seed();
    await settle();
    expect(await act(async () => agentRun.restart("ws-1", "pane-1", "fresh"))).toBe(
      "restarted",
    );
    expect(await act(async () => agentRun.restart("ws-1", "nope", "fresh"))).toBe(
      "gone",
    );
  });
  it("retryPlanBuild actually REBUILDS — the tile's retry is not just a reset", async () => {
    // Dropping the failed plan is half a retry. Nothing else was listening to
    // that cache, so the sweep never re-ran and the error tile turned into a
    // permanent "Waking up…" spinner with its retry button gone.
    seed();
    await settle();
    expect(peekPaneSpawnSpec("pane-1")).toBeDefined();
    act(() => agentRun.retryPlanBuild("pane-1"));
    await settle();
    expect(peekPaneSpawnSpec("pane-1")).toBeDefined();
    expect(agentRun.specs["pane-1"]).toBeDefined();
  });
  it("auto-recovers a rejected BOOT resume exactly once", async () => {
    seed();
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "restore",
      postbackMark: 0,
    });
    act(() => {
      agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    await act(async () => {});
    expect(pty.closed).toEqual(["pane-1"]);
    expect(telemetry.retirePaneTelemetry).toHaveBeenCalledWith("pane-1");
    expect(pane().session).toBeUndefined();
    expect(epoch()).toBe(1);
    // The spec is gone, so the predicate answers false for the next exit.
    act(() => {
      agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    expect(pty.closed).toEqual(["pane-1"]);
  });
  it("keeps the promise it makes the caller — respawns even off screen", async () => {
    // It answers `true`, which is how App knows this exit is a respawn and not
    // a crash worth notifying about. The respawn is the sweep's job now, and
    // the sweep holds a pane whose workspace nobody has opened — so the pane
    // was left with its binding wiped, no process, and nothing saying so.
    seed();
    act(() => deck.createWorkspace(otherWorkspace()));
    act(() => deck.selectWorkspace("ws-2"));
    await settle();
    pty.acquired = [];
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "restore",
      postbackMark: 0,
    });
    let recovering: unknown;
    act(() => {
      recovering = agentRun.recoverRejectedResume("ws-1", "pane-1", 1);
    });
    await settle();
    expect(recovering).toBe(true);
    expect(pane().session).toBeUndefined();
    expect(pty.acquired.map((a) => a.paneId)).toEqual(["pane-1"]);
  });
  it("never auto-recovers an ordinary exit or a rejected MANUAL resume", () => {
    seed();
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "manual",
      postbackMark: 0,
    });
    act(() => {
      expect(agentRun.recoverRejectedResume("ws-1", "pane-1", 1)).toBe(false);
    });
    expect(pty.closed).toEqual([]);
    expect(epoch()).toBeUndefined();
    expect(pane().session?.id).toBe("session-old");
  });
});
