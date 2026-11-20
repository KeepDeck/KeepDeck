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
  machine,
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

  /** The panes the machine was asked to suspend. */
  const suspended = () => machine.intents.flatMap((intent) => (intent.kind === "suspend" ? [intent.pane] : []));

  describe("suspendTeam", () => {
    it("asks the machine to suspend exactly the members it was shown, and no other team's", async () => {
      await live(team([{}, {}, { idle: { reason: "parked" } }]));

      await act(async () => {
        await agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });

      expect(suspended()).toEqual(["m1", "m2"]);
      expect(idleOf("m1")).toMatchObject({ reason: "suspended" });
      expect(idleOf("m3")).toEqual({ reason: "parked" });
      expect(idleOf("other")).toBeUndefined();
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

      expect(suspended()).toEqual(["m1"]);
      expect(idleOf("m2")).toBeUndefined();
    });

    it("drops a shown member that is no longer stoppable, without a word", async () => {
      await live(team([{}, {}]));
      await act(async () => {
        await agentRun.suspend("ws-1", "m2");
      });
      machine.intents = [];

      await act(async () => {
        await agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });

      expect(suspended()).toEqual(["m1"]);
    });

    it("leaves a member the machine is still suspending — the menu offers what the door takes", async () => {
      await live(team([{}, {}]));
      act(() => {
        machine.phases = { m2: "suspending" };
        machine.publish();
      });
      expect(agentRun.teamActs("ws-1", "team-1")?.suspend).toEqual({ take: ["m1"], skip: ["in-flight"] });

      await act(async () => {
        await agentRun.suspendTeam("ws-1", "team-1", ["m1", "m2"]);
      });
      expect(suspended()).toEqual(["m1"]);
    });
  });

  describe("teamActs — what the menu offers is what the doors take", () => {
    it("answers the members each door then takes", async () => {
      await live(team([{}, { idle: { reason: "parked" } }, { idle: { reason: "suspended", at: AT } }]));

      const before = agentRun.teamActs("ws-1", "team-1");
      expect(before?.suspend.take).toEqual(["m1"]);
      expect(before?.resume.take).toEqual(["m2", "m3"]);

      // Suspend, named exactly what it offered, asks for exactly that…
      await act(async () => {
        await agentRun.suspendTeam("ws-1", "team-1", before?.suspend.take ?? []);
      });
      expect(suspended()).toEqual(before?.suspend.take);

      // …and Resume, asked after it, asks back exactly what it offers now.
      const now = agentRun.teamActs("ws-1", "team-1");
      expect(now?.resume.take).toEqual(["m1", "m2", "m3"]);
      await act(async () => {
        await agentRun.resumeTeam("ws-1", "team-1");
      });
      // Each is up or rising — none still down by a decision.
      const askedBack = ["m1", "m2", "m3"].filter((paneId) => {
        const reason = idleOf(paneId)?.reason;
        return reason !== "suspended" && reason !== "parked";
      });
      expect(askedBack).toEqual(now?.resume.take);
      // Let the sweep finish the wakes it was asked for, inside the test.
      await settle();
    });

    it("reads the sweep's folder verdict, as the doors do", async () => {
      ipc.probeWorktree.mockResolvedValue({ exists: false, isWorktree: false, empty: false, branch: null });
      act(() => deck.hydrate(team([{ idle: { reason: "waking", origin: "restore" } }])));
      await settle();
      expect(agentRun.blocked).toEqual({ m1: "/repo/wt-1" });

      expect(agentRun.teamActs("ws-1", "team-1")?.resume).toEqual({
        take: [],
        skip: ["blocked"],
      });
    });

    it("answers nothing for a team that is not there", async () => {
      await live(team([{}]));
      expect(agentRun.teamActs("ws-1", "team-9")).toBeNull();
      expect(agentRun.teamActs("ws-9", "team-1")).toBeNull();
    });
  });

  describe("resumeTeam", () => {
    it("asks back the parked and the suspended, and the sweep brings each into its own session", async () => {
      act(() =>
        deck.hydrate(team([{ idle: { reason: "parked" } }, { idle: { reason: "suspended", at: AT } }, {}])),
      );
      await settle();

      await act(async () => {
        await agentRun.resumeTeam("ws-1", "team-1");
      });
      await settle();

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

      await act(async () => {
        await agentRun.resumeTeam("ws-1", "team-1");
      });

      expect(deck.viewByWs["ws-1"]?.suspendedTray).toBeUndefined();
      expect(deck.viewByWs["ws-1"]?.minimized).toEqual(["m2"]);
      await settle();
    });

    it("changes nothing on a team with nobody down", async () => {
      await live(team([{}, {}]));
      const before = deck.workspaces;
      await act(async () => {
        await agentRun.resumeTeam("ws-1", "team-1");
      });
      expect(deck.workspaces).toBe(before);
    });
  });
});
