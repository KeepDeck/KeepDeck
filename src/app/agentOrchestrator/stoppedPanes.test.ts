// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import {
  Probe,
  agentRun,
  catalog,
  createWorkspaceInstance,
  deck,
  emptyJournal,
  ipc,
  pty,
  resetPaneSpawnSpecs,
  settle,
} from "./testSupport";
import type { DeckState } from "./testSupport";

/**
 * A pane whose process the machine stopped in THIS run, then asked back.
 *
 * The machine stops a process by its exact session; the page's registry then
 * holds it "exited" until something closes its slot, and the funnel starts
 * nothing into a slot still taken. Before the stop moved into the machine,
 * the page's own suspend, archive and close emptied it themselves
 * (`endPaneProcess` → `sessions.close`); now the machine's Release does, once
 * the sessions are over. These hold what the person sees: the agent comes
 * back when asked, and a pane that is gone leaves no slot behind.
 */
describe("agent orchestrator — a pane the machine stopped in this run", () => {
  let root: Root;
  const instance = createWorkspaceInstance();
  const ref = { id: "ws-1", instance };

  /** One team of two at the workspace root, both up — as a team stands a
   * moment after its agents were added. */
  const team = (): DeckState => ({
    workspaces: [
      {
        id: "ws-1",
        instance,
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        teams: [{ id: "team-1", name: "Team 1", location: { kind: "attached", cwd: "/repo" } }],
        panes: [
          { id: "pane-1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
          { id: "pane-2", agentType: "codex", team: { teamId: "team-1", role: "impl-1" } },
        ],
      },
    ],
    activeId: "ws-1",
    journal: emptyJournal,
    viewByWs: {},
  });

  /** The same team with a third member joining it. */
  const withThird = (): DeckState => {
    const state = team();
    const [ws] = state.workspaces;
    return {
      ...state,
      workspaces: [{ ...ws, panes: [...ws.panes, { id: "pane-3", agentType: "claude", team: { teamId: "team-1", role: "impl-2" } }] }],
    };
  };

  const launches = (paneId: string) => pty.acquired.filter((launch) => launch.paneId === paneId).length;
  const idleOf = (paneId: string) => deck.workspaces[0]?.panes.find((pane) => pane.id === paneId)?.idle;

  beforeEach(async () => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
    act(() => deck.hydrate(team()));
    await settle();
    // Both agents are up, as the person left them.
    expect([launches("pane-1"), launches("pane-2")]).toEqual([1, 1]);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("comes back when one agent suspended in this run is resumed", async () => {
    await act(async () => {
      await agentRun.suspend("ws-1", "pane-1");
    });
    await settle();
    expect(idleOf("pane-1")).toMatchObject({ reason: "suspended" });
    // Its process is over, and nothing of it is held: the slot is empty. Its
    // terminal stays mounted: nothing replaces the process in place.
    expect(pty.state("pane-1").kind).toBe("none");
    expect(agentRun.epochs["pane-1"] ?? 0).toBe(0);

    await act(async () => {
      await agentRun.resume("ws-1", "pane-1");
    });
    await settle();
    expect(idleOf("pane-1")).toBeUndefined();
    expect(launches("pane-1")).toBe(2);
    expect(pty.isLive("pane-1")).toBe(true);
  });

  it("brings the whole team back when a team suspended in this run is resumed", async () => {
    await act(async () => {
      await agentRun.suspendTeam("ws-1", "team-1", ["pane-1", "pane-2"]);
    });
    await settle();
    expect([idleOf("pane-1")?.reason, idleOf("pane-2")?.reason]).toEqual(["suspended", "suspended"]);

    await act(async () => {
      await agentRun.resumeTeam("ws-1", "team-1");
    });
    await settle();
    expect([launches("pane-1"), launches("pane-2")]).toEqual([2, 2]);
    expect([pty.isLive("pane-1"), pty.isLive("pane-2")]).toEqual([true, true]);
  });

  it("brings an agent back when it is resumed in a workspace archived and restored in this run", async () => {
    await act(async () => {
      await agentRun.archive(ref);
    });
    await settle();
    await act(async () => {
      await agentRun.restore(ref);
    });
    await settle();
    expect(idleOf("pane-1")).toMatchObject({ reason: "suspended" });

    await act(async () => {
      await agentRun.resume("ws-1", "pane-1");
    });
    await settle();
    expect(launches("pane-1")).toBe(2);
    expect(pty.isLive("pane-1")).toBe(true);
  });

  it("brings back an agent suspended while it was still starting", async () => {
    // The start boundary cancels a launch a stop overtakes: the spawn is
    // refused, and the slot holds a failed start — no process, and no exit
    // will ever come to empty it.
    pty.holdStarts = true;
    act(() => deck.hydrate(withThird()));
    await settle();
    expect(pty.state("pane-3").kind).toBe("starting");
    pty.holdStarts = false;

    await act(async () => {
      await agentRun.suspend("ws-1", "pane-3");
    });
    await settle();
    expect(pty.state("pane-3").kind).toBe("none");

    await act(async () => {
      await agentRun.resume("ws-1", "pane-3");
    });
    await settle();
    expect(launches("pane-3")).toBe(2);
    expect(pty.isLive("pane-3")).toBe(true);
  });

  it("brings back an agent whose stop was never confirmed", async () => {
    // Its process did not exit within the stop's bound: no exit is reported,
    // and the slot still reads live when the operation is over.
    pty.unconfirmed.add("pane-1");
    await act(async () => {
      await agentRun.suspend("ws-1", "pane-1");
    });
    await settle();
    expect(pty.state("pane-1").kind).toBe("none");

    await act(async () => {
      await agentRun.resume("ws-1", "pane-1");
    });
    await settle();
    expect(launches("pane-1")).toBe(2);
    expect(pty.isLive("pane-1")).toBe(true);
  });

  it("leaves no slot behind for an agent closed in this run", async () => {
    await act(async () => {
      await agentRun.close({ kind: "agent", workspace: ref, paneId: "pane-2", consent: { stops: ["pane-2"], folders: [], tickets: [] } });
    });
    await settle();
    expect(deck.workspaces[0]?.panes.map((pane) => pane.id)).toEqual(["pane-1"]);
    expect(pty.state("pane-2").kind).toBe("none");
  });

  it("remounts a restarted pane once its new process is up, so its restart card lets go", async () => {
    // The pane's Restart keeps its spinner — and its buttons inert — until a
    // remount: the remount is what says the restart happened (useRestart,
    // rule one). Without it, the next exit card of that pane offers no way
    // back.
    const before = agentRun.epochs["pane-1"] ?? 0;
    await act(async () => {
      await agentRun.restart("ws-1", "pane-1", "fresh");
    });
    await settle();
    expect(launches("pane-1")).toBe(2);
    expect(agentRun.epochs["pane-1"] ?? 0).toBeGreaterThan(before);
  });

  it("keeps an agent that exited by itself on its exit card: nothing asked for it again", async () => {
    act(() => pty.exit("pane-1", 1));
    await settle();
    expect(pty.state("pane-1").kind).toBe("exited");
    expect(launches("pane-1")).toBe(1);
  });
});
