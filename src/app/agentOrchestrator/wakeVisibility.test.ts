// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Probe,
  agentRun,
  catalog,
  createWorkspaceInstance,
  deck,
  emptyJournal,
  ipc,
  peekPaneSpawnSpec,
  pty,
  resetPaneSpawnSpecs,
  settle,
} from "./testSupport";
import type { DeckState } from "./testSupport";
import { present } from "@keepdeck/plugin-api/testing";

// The rest of this suite runs on the host (wakeVisibility.host.test.ts).
// These two rows stay until task-917: on the real app a resume whose folder
// is gone strands the agent, and their host scenarios come with that fix.
describe("agent orchestrator —a blocked pane can be re-probed", () => {
  let root: Root;

  const blockedDeck = (): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        teams: [{ id: "team-1", name: "one", location: { kind: "attached", cwd: "/repo/wt-1" } }],
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            team: { teamId: "team-1", role: "lead" },
            session: { id: "s-1", boundAt: "t" },
            idle: { reason: "suspended", at: "2026-07-25T09:00:00.000Z" },
          },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const pane = () => deck.workspaces[0].panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset();
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("looks again when the folder comes back, keeping the session", async () => {
    // A blocked pane is skipped for the rest of the session, so without a
    // retry an unmounted volume left it stuck behind a card whose only other
    // exit throws the binding away.
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(blockedDeck()));
    await settle();
    act(() => deck.requestPanesWake("ws-1", ["pane-1"]));
    await settle();
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");

    // The volume is back.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    await act(async () => {
      await agentRun.resume("ws-1", "pane-1");
    });
    await settle();

    expect(agentRun.blocked["pane-1"]).toBeUndefined();
    expect(pane().idle).toBeUndefined(); // live again
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
    expect(peekPaneSpawnSpec("pane-1")?.args).toEqual(["--resume", "s-1"]);
  });

  it("stays blocked, with its stamp, when the folder is still gone", async () => {
    ipc.probeWorktree.mockResolvedValue({
      exists: false,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => deck.hydrate(blockedDeck()));
    await settle();
    act(() => deck.requestPanesWake("ws-1", ["pane-1"]));
    await settle();

    await act(async () => {
      await agentRun.resume("ws-1", "pane-1");
    });
    await settle();

    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });
});
