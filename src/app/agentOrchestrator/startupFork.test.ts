// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Probe,
  agentRun,
  buildForkSpec,
  catalog,
  createWorkspaceInstance,
  deck,
  ipc,
  plans,
  pty,
  resetPaneSpawnSpecs,
  settle,
  steps,
} from "./testSupport";

/**
 * The offer beside a start that has gone quiet forks the session the pane is
 * already bound to. It shares its whole body with the occupied card's offer
 * and differs only in what earns the right to ask — which is exactly the part
 * that must not be shared, and the part these tests hold apart.
 */
describe("agent orchestrator —forking a pane whose start went quiet", () => {
  let root: Root;

  beforeEach(async () => {
    resetPaneSpawnSpecs();
    vi.mocked(buildForkSpec).mockClear();
    steps.register.mockClear();
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
        name: "ws-1",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            session: { id: "s-1", boundAt: "2026-08-25T00:00:00.000Z" },
          },
        ],
      }),
    );
    // Let the reconcile pass the new workspace kicks off finish, so a later
    // assertion is about the fork and not about a sweep still landing.
    await act(async () => settle());
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("forks the bound session into the same directory", async () => {
    await act(async () => agentRun.forkStalledSession("ws-1", "pane-1"));

    const call = vi.mocked(buildForkSpec).mock.calls[0];
    expect(call, "the fork never happened").toBeDefined();
    expect(call[4]).toMatchObject({ sessionId: "s-1" });
    // Same directory by definition — the offer never chooses one, and a fork
    // into somewhere else would be a different action wearing this label.
    expect(call[2]).toMatchObject({ cwd: "/repo" });
  });

  it("does not need the occupied note the other offer needs", async () => {
    // The regression this pins: reusing the occupied guard here would have
    // made the button a silent no-op on every pane it is ever shown on,
    // because a stuck start is not an occupied session.
    await act(async () => agentRun.forkOccupiedSession("ws-1", "pane-1"));
    expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();

    await act(async () => agentRun.forkStalledSession("ws-1", "pane-1"));
    expect(vi.mocked(buildForkSpec)).toHaveBeenCalledTimes(1);
  });

  it("counts the wait for a continuation, and not for a fresh start", async () => {
    // The pane the harness already started carries an ordinary plan: a fresh
    // start, which nobody is counting. Telling someone their brand-new agent
    // is slow — and offering to fork a session it does not have — would be a
    // hint about the wrong thing entirely.
    expect(agentRun.startup["pane-1"]).toBeUndefined();

    plans.specs.set("pane-2", {
      command: "claude",
      args: [],
      env: [],
      resumeOf: "s-1",
    });
    act(() =>
      deck.addAgentPane("ws-1", { id: "pane-2", agentType: "claude" }),
    );
    await act(async () => settle());

    expect(agentRun.startup["pane-2"]).toMatchObject({ slow: false });
  });

  it("does nothing for a pane bound to no session", async () => {
    act(() =>
      deck.createWorkspace({
        id: "ws-2",
        instance: createWorkspaceInstance(),
        name: "ws-2",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-2", agentType: "claude" }],
      }),
    );

    await act(async () => agentRun.forkStalledSession("ws-2", "pane-2"));

    expect(vi.mocked(buildForkSpec)).not.toHaveBeenCalled();
  });
});
