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
import type {
  DeckState,
  PaneIdle,
} from "./testSupport";

describe("agent orchestrator —waking across workspace switches", () => {
  let root: Root;

  /** Two workspaces, ws-1 active, one pane each with the given idle reason
   *  (or none, for panes that simply exist). */
  const twoWorkspaces = (idle?: PaneIdle): DeckState => ({
    workspaces: ["ws-1", "ws-2"].map((id) => ({
      id,
      instance: createWorkspaceInstance(),
      name: id,
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: `${id}-pane`, agentType: "claude", ...(idle && { idle }) }],
    })),
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  const paneOf = (wsId: string) =>
    deck.workspaces.find((w) => w.id === wsId)!.panes[0];

  beforeEach(() => {
    resetPaneSpawnSpecs();
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

  it("starts the pane on screen and leaves the one nobody has opened alone", async () => {
    // The economy this whole gate exists for: a workspace that may never be
    // used costs nothing. Both panes are unmarked and both have plans — only
    // the visible one gets a process.
    act(() => deck.hydrate(twoWorkspaces(undefined)));
    await settle();

    expect(pty.acquired.map((a) => a.paneId)).toEqual(["ws-1-pane"]);
  });

  it("starts the second one when its workspace is opened, and only then", async () => {
    act(() => deck.hydrate(twoWorkspaces(undefined)));
    await settle();
    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(pty.acquired.map((a) => a.paneId)).toEqual(["ws-1-pane", "ws-2-pane"]);
  });

  it("does not start a second process for a pane that already has one", async () => {
    act(() => deck.hydrate(twoWorkspaces(undefined)));
    await settle();
    // Any notification re-runs the reconcile; the started pane must be left
    // exactly as it is.
    act(() => deck.renameWorkspace("ws-1", "renamed"));
    await settle();

    expect(pty.acquired).toHaveLength(1);
  });

  it("stops starting agents the moment the launch policy says so, and says they are stopped", async () => {
    // The bug this closes: the policy used to be applied once, to the deck as
    // it was hydrated. A pane waiting in an unopened workspace kept the marker
    // it was given at boot, so turning the setting on and then switching
    // workspaces started every agent in them anyway.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();
    expect(paneOf("ws-2").idle).toEqual({ reason: "waking", origin: "restore" });

    // ws-1's pane legitimately started with the deck; only what happens AFTER
    // the flip is the subject.
    ipc.probeWorktree.mockClear();
    catalog.parkOnLaunch = true;
    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });
    // Not merely unstarted: nothing was even probed for it.
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });

  it("leaves the agent that is already running alone when the policy flips", async () => {
    // ws-1's pane started with the deck. A preference changing must not reach
    // back and kill a live agent.
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();
    expect(paneOf("ws-1").idle).toBeUndefined();

    catalog.parkOnLaunch = true;
    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-1").idle).toBeUndefined();
  });

  it("still serves a resume the user asks for while the policy is on", async () => {
    catalog.parkOnLaunch = true;
    act(() => deck.hydrate(twoWorkspaces({ reason: "parked" })));
    await settle();
    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });

    expect(agentRun.resume("ws-2", "ws-2-pane")).toBe("resuming");
    await settle();

    expect(paneOf("ws-2").idle).toBeUndefined();
  });

  it("RESTORED panes wake lazily: the active workspace at launch, the other on its first activation", async () => {
    act(() => deck.hydrate(twoWorkspaces({ reason: "waking", origin: "restore" })));
    await settle();

    expect(paneOf("ws-1").idle).toBeUndefined(); // launched with the deck
    expect(paneOf("ws-2").idle).toEqual({ reason: "waking", origin: "restore" }); // still asleep

    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-2").idle).toBeUndefined(); // woken by the switch
  });

  it("PARKED panes stay stopped through a workspace switch, not just at launch", async () => {
    act(() => deck.hydrate(twoWorkspaces({ reason: "parked" })));
    await settle();

    act(() => deck.selectWorkspace("ws-2"));
    await settle();

    expect(paneOf("ws-1").idle).toEqual({ reason: "parked" });
    expect(paneOf("ws-2").idle).toEqual({ reason: "parked" });
    expect(ipc.probeWorktree).not.toHaveBeenCalled();
  });
});

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
        panes: [
          {
            id: "pane-1",
            agentType: "claude",
            cwd: "/repo/wt-1",
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
    root = createRoot(document.getElementById("host")!);
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
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();
    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");

    // The volume is back.
    ipc.probeWorktree.mockResolvedValue({
      exists: true,
      isWorktree: false,
      empty: false,
      branch: null,
    });
    act(() => agentRun.resume("ws-1", "pane-1"));
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
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    act(() => agentRun.resume("ws-1", "pane-1"));
    await settle();

    expect(agentRun.blocked["pane-1"]).toBe("/repo/wt-1");
    expect(pane().session).toEqual({ id: "s-1", boundAt: "t" });
  });
});
