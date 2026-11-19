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
import type { DeckState, Pane } from "./testSupport";
import { present } from "@keepdeck/plugin-api/testing";

const AT = "2026-11-19T09:00:00.000Z";

/** One team of four on a worktree, its members as `panes` says, beside a
 * second team whose member no team act of the first may touch. */
const team = (panes: Partial<Pane>[], view: DeckState["viewByWs"] = {}): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      teams: [
        { id: "team-1", name: "one", location: { kind: "attached", cwd: "/repo/wt-1", branch: "kd/ws/1" } },
        { id: "team-2", name: "two", location: { kind: "attached", cwd: "/repo/wt-2", branch: "kd/ws/2" } },
      ],
      panes: [
        ...panes.map(
          (pane, i): Pane => ({
            id: `m${i + 1}`,
            agentType: "claude",
            team: { teamId: "team-1", role: `r${i + 1}` },
            session: { id: `s-${i + 1}`, boundAt: "t" },
            ...pane,
          }),
        ),
        { id: "other", agentType: "claude", team: { teamId: "team-2", role: "lead" } },
      ],
    },
  ],
  activeId: "ws-1",
  journal: emptyJournal,
  viewByWs: view,
});

const idleOf = (paneId: string) => deck.workspaces[0].panes.find((pane) => pane.id === paneId)?.idle;

describe("agent orchestrator —a team's Suspend and Resume", () => {
  let root: Root;

  beforeEach(() => {
    resetPaneSpawnSpecs();
    ipc.probeWorktree.mockReset().mockResolvedValue({ exists: true, isWorktree: false, empty: false, branch: null });
    catalog.ready = true;
    catalog.parkOnLaunch = false;
    catalog.moveSuspendedToTray = false;
    pty.reset();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "the host element"));
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  /** A team brought up live: hydrated, swept, every member running. */
  const live = async (state: DeckState) => {
    act(() => deck.hydrate(state));
    await settle();
  };

  describe("suspendTeam", () => {
    it("stops exactly the members it was shown, and no other team's", async () => {
      await live(team([{}, {}, { idle: { reason: "parked" } }]));

      let requested: readonly string[] = [];
      await act(async () => {
        requested = await agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });

      expect(requested).toEqual(["m1", "m2"]);
      expect(idleOf("m1")).toMatchObject({ reason: "suspended" });
      expect(idleOf("m2")).toMatchObject({ reason: "suspended" });
      expect(idleOf("m3")).toEqual({ reason: "parked" });
      expect(idleOf("other")).toBeUndefined();
      expect(pty.closed.sort()).toEqual(["m1", "m2"]);
    });

    it("never takes a member that was not shown — one that became stoppable since does not join", async () => {
      await live(team([{}, { idle: { reason: "parked" } }]));
      // The confirm showed m1 only; m2 came up while it stood open.
      act(() => deck.requestPanesWake("ws-1", ["m2"]));
      await settle();
      expect(idleOf("m2")).toBeUndefined();

      await act(async () => {
        await agentRun.suspendTeam("ws-1", "team-1", ["m1"]);
      });

      expect(idleOf("m1")).toMatchObject({ reason: "suspended" });
      expect(idleOf("m2")).toBeUndefined();
      expect(pty.closed).toEqual(["m1"]);
    });

    it("drops a shown member that is no longer stoppable, without a word", async () => {
      await live(team([{}, {}]));
      await act(async () => {
        await agentRun.suspend("ws-1", "m2");
      });
      pty.closed = [];

      let requested: readonly string[] = [];
      await act(async () => {
        requested = await agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });

      expect(requested).toEqual(["m1"]);
      expect(pty.closed).toEqual(["m1"]);
    });

    it("leaves a member another suspend is still reaping, even once it is asked back mid-reap", async () => {
      await live(team([{}, {}]));
      let release!: () => void;
      pty.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let single!: Promise<unknown>;
      act(() => {
        single = agentRun.suspend("ws-1", "m2");
      });
      // Asked back while its process is still going down: rising again, so
      // a Suspend may take it — but not a second one over the first.
      act(() => {
        agentRun.resume("ws-1", "m2");
      });
      expect(idleOf("m2")).toMatchObject({ reason: "waking" });

      let whole!: Promise<readonly string[]>;
      act(() => {
        whole = agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });
      act(() => release());

      expect(await act(async () => whole)).toEqual(["m1"]);
      await act(async () => single);
      expect(pty.closed.filter((paneId) => paneId === "m2")).toHaveLength(1);
    });

    it("moves every stopped member to the tray when that is the placement", async () => {
      catalog.moveSuspendedToTray = true;
      await live(team([{}, {}]));

      await act(async () => {
        await agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });

      expect(deck.viewByWs["ws-1"]?.suspendedTray).toEqual(["m1", "m2"]);
    });
  });

  describe("resumeTeam", () => {
    it("asks back the parked and the suspended, and the sweep brings each into its own session", async () => {
      act(() =>
        deck.hydrate(team([{ idle: { reason: "parked" } }, { idle: { reason: "suspended", at: AT } }, {}])),
      );
      await settle();

      let asked: readonly string[] = [];
      act(() => {
        asked = agentRun.resumeTeam("ws-1", "team-1");
      });
      await settle();

      expect(asked).toEqual(["m1", "m2"]);
      expect(idleOf("m1")).toBeUndefined();
      expect(idleOf("m2")).toBeUndefined();
      expect(peekPaneSpawnSpec("m1")?.args).toEqual(["--resume", "s-1"]);
      expect(peekPaneSpawnSpec("m2")?.args).toEqual(["--resume", "s-2"]);
    });

    it("takes the woken members off the suspended tray, and leaves a minimized one minimized", async () => {
      act(() =>
        deck.hydrate(
          team(
            [{ idle: { reason: "suspended", at: AT } }, { idle: { reason: "suspended", at: AT } }],
            { "ws-1": { teamOpen: "team-1", suspendedTray: ["m1", "m2"], minimized: ["m2"] } },
          ),
        ),
      );
      await settle();

      act(() => {
        agentRun.resumeTeam("ws-1", "team-1");
      });

      expect(deck.viewByWs["ws-1"]?.suspendedTray).toBeUndefined();
      expect(deck.viewByWs["ws-1"]?.minimized).toEqual(["m2"]);
    });

    it("asks nobody back on a team with nobody down", async () => {
      await live(team([{}, {}]));
      let asked: readonly string[] = ["x"];
      act(() => {
        asked = agentRun.resumeTeam("ws-1", "team-1");
      });
      expect(asked).toEqual([]);
    });
  });
});
