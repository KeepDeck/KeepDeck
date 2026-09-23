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
 * A start that has gone quiet is counted, so its card can offer a way
 * forward — a fork, through the member dialog.
 */
describe("agent orchestrator —a pane whose start went quiet", () => {
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

});
