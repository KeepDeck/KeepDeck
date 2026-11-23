// @vitest-environment happy-dom
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Intent } from "../../ipc/generated/lifecycle/Intent";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { useHost } from "../../testing/host/host";
import { quitAfter, startDeck, type Deck } from "../../testing/host/deck";
import type { StubAgentControl } from "../../testing/host/stubPlugin";

/**
 * A team's Suspend and Resume, end to end on the app itself: what the menu
 * offers, what each door then takes — the members it was shown and no
 * others — and how the members come back.
 */
describe("a team's Suspend and Resume, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const folder = (name: string) => {
    const path = join(host().work, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const idleOf = (d: Deck, paneId: string) => d.pane(paneId).idle;
  /** The panes the machine was asked to suspend since `mark` intents. */
  const suspendsSince = (d: Deck, mark: number) =>
    d.intents().slice(mark).flatMap((intent: Intent) => (intent.kind === "suspend" ? [intent.pane] : []));
  const suspendOne = async (d: Deck, ws: WorkspaceRef, paneId: string) => {
    expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
    await host().until(`${paneId} suspended`, () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none", 15_000);
  };
  const resumeOne = async (d: Deck, ws: WorkspaceRef, paneId: string) => {
    expect(await d.runtime.orchestrator.resume(ws.id, paneId)).toMatchObject({ kind: "resuming" });
    await host().until(`${paneId} up`, () => d.slot(paneId) === "live" && idleOf(d, paneId) === undefined, 15_000);
  };
  const settingsOnDisk = () => {
    const file = join(host().home, "settings.json");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };

  /** A team of three on the root — its lead and two members, up and bound
   * — beside a second team with one agent of its own. */
  async function teams(d: Deck) {
    const { ws, paneId: m1 } = await d.agentUp();
    const team = d.pane(m1).team?.teamId ?? "";
    const m2 = await d.memberUp(team, "impl-1");
    const m3 = await d.memberUp(team, "reviewer-1");
    const otherTeam = await d.teamUp("two", { kind: "existing", cwd: folder("two") });
    const other = await d.addAgent({ role: "lead", team: otherTeam });
    await d.upAndBound(other);
    return { ws, team, m1, m2, m3, other, sessions: [m1, m2, m3].map((paneId) => d.pane(paneId).session?.id ?? "") };
  }

  /** A team of two up: its lead, and a member slow to stop — only the kill
   * ends it. */
  async function slowToStop() {
    const d = await open();
    const { ws, paneId: m1 } = await d.agentUp();
    const team = d.pane(m1).team?.teamId ?? "";
    d.stub.deaf = true;
    const m2 = await d.memberUp(team, "impl-1");
    d.stub.deaf = false;
    return { d, ws, team, m1, m2 };
  }

  /** The same teams, quit with the launch policy on: the next launch parks
   * every one of them. */
  const parkedAtLaunch = async () => {
    const made = await quitAfter(
      host(),
      async (d) => {
        const up = await teams(d);
        d.updateSettings({ parkAgentsOnLaunch: true });
        return up;
      },
      (onDisk, { sessions }) => sessions.every((id) => onDisk.includes(id)) && settingsOnDisk().includes('"parkAgentsOnLaunch":true'),
    );
    const d = await open();
    await host().until("every agent parked", () => [made.m1, made.m2, made.m3, made.other].every((paneId) => idleOf(d, paneId)?.reason === "parked"), 15_000);
    return { d, ...made };
  };

  describe("Suspend", () => {
    it("asks the machine to suspend exactly the members it was shown, and no other team's", async () => {
      const { d, ws, team, m1, m2, m3, other } = await parkedAtLaunch();
      for (const paneId of [m1, m2, other]) await resumeOne(d, ws, paneId);
      const mark = d.intents().length;
      await d.runtime.orchestrator.suspendTeam(ws.id, team, [m1, m2]);
      expect(suspendsSince(d, mark)).toEqual([m1, m2]);
      await host().until("suspended", () => idleOf(d, m1)?.reason === "suspended" && idleOf(d, m2)?.reason === "suspended", 15_000);
      expect(idleOf(d, m3)).toEqual({ reason: "parked" });
      expect(idleOf(d, other)).toBeUndefined();
    });

    it("never takes a member that was not shown — one that became stoppable since does not join", async () => {
      const { d, ws, team, m1, m2 } = await parkedAtLaunch();
      await resumeOne(d, ws, m1);
      // The confirm showed m1 only; m2 came up while it stood open.
      await resumeOne(d, ws, m2);
      const mark = d.intents().length;
      await d.runtime.orchestrator.suspendTeam(ws.id, team, [m1]);
      expect(suspendsSince(d, mark)).toEqual([m1]);
      expect(idleOf(d, m2)).toBeUndefined();
    });

    it("drops a shown member that is no longer stoppable, without a word", async () => {
      const d = await open();
      const { ws, team, m1, m2 } = await teams(d);
      await suspendOne(d, ws, m2);
      const mark = d.intents().length;
      await d.runtime.orchestrator.suspendTeam(ws.id, team, [m1, m2]);
      expect(suspendsSince(d, mark)).toEqual([m1]);
    });

    it("takes nobody while the machine is still suspending a member — the menu offers what the door takes", async () => {
      const { d, ws, team, m1, m2 } = await slowToStop();
      await d.runtime.orchestrator.suspend(ws.id, m2);
      await host().until("still being suspended", () => d.phase(m2) === "suspending");
      expect(d.runtime.orchestrator.teamActs(ws.id, team)?.suspend).toEqual({ take: [], skip: ["settling", "settling"] });
      const mark = d.intents().length;
      await d.runtime.orchestrator.suspendTeam(ws.id, team, [m1, m2]);
      expect(suspendsSince(d, mark)).toEqual([]);
    });
  });

  describe("what the menu offers is what the doors take", () => {
    it("answers the members each door then takes", async () => {
      const { d, ws, team, m1, m2, m3 } = await parkedAtLaunch();
      await resumeOne(d, ws, m1);
      await resumeOne(d, ws, m3);
      await suspendOne(d, ws, m3);
      const before = d.runtime.orchestrator.teamActs(ws.id, team);
      expect(before?.suspend.take).toEqual([m1]);
      expect(before?.resume.take).toEqual([m2, m3]);
      // Suspend, named exactly what it offered, asks for exactly that…
      const mark = d.intents().length;
      await d.runtime.orchestrator.suspendTeam(ws.id, team, before?.suspend.take ?? []);
      expect(suspendsSince(d, mark)).toEqual(before?.suspend.take);
      await host().until("suspended", () => d.phase(m1) === "suspended" && d.settled());
      // …and Resume, asked after it, asks back exactly what it offers now.
      const now = d.runtime.orchestrator.teamActs(ws.id, team);
      expect(now?.resume.take).toEqual([m1, m2, m3]);
      const answers = await d.runtime.orchestrator.resumeTeam(ws.id, team);
      expect(answers).toEqual((now?.resume.take ?? []).map((paneId) => ({ paneId, outcome: { kind: "resuming" } })));
      // Each rises: none stays down by a decision.
      await host().until("all back", () => [m1, m2, m3].every((paneId) => d.slot(paneId) === "live" && idleOf(d, paneId) === undefined), 15_000);
    });

    it("reads the sweep's folder verdict, as the doors do", async () => {
      const place = folder("api");
      const { team } = await quitAfter(
        host(),
        async (d) => {
          await d.workspaceUp();
          const made = await d.teamUp("api", { kind: "existing", cwd: place });
          const paneId = await d.addAgent({ role: "lead", team: made });
          return { team: made, paneId, session: await d.upAndBound(paneId) };
        },
        (onDisk, { session }) => onDisk.includes(session),
        // The folder goes while the app is down.
        () => rmSync(place, { recursive: true, force: true }),
      );
      const d = await open();
      const ws = d.workspace();
      await host().until("its folder is gone", () => Object.values(d.runtime.orchestrator.getView().blocked).includes(place), 15_000);
      expect(d.runtime.orchestrator.teamActs(ws.id, team)?.resume).toEqual({ take: [], skip: ["blocked"] });
    });

    it("answers nothing for a team that is not there", async () => {
      const d = await open();
      const { ws, team } = await teams(d);
      expect(d.runtime.orchestrator.teamActs(ws.id, "team-9")).toBeNull();
      expect(d.runtime.orchestrator.teamActs("ws-9", team)).toBeNull();
    });
  });

  describe("Resume", () => {
    it("asks back the parked and the suspended, and each rises into its own conversation", async () => {
      const { d, ws, team, m1, m2, m3, sessions } = await parkedAtLaunch();
      await resumeOne(d, ws, m2);
      await suspendOne(d, ws, m2);
      await resumeOne(d, ws, m3);
      await d.runtime.orchestrator.resumeTeam(ws.id, team);
      await host().until("both back", () => d.slot(m1) === "live" && d.slot(m2) === "live" && idleOf(d, m1) === undefined && idleOf(d, m2) === undefined, 15_000);
      const lastArgs = (paneId: string) => d.launches(paneId)[d.launches(paneId).length - 1]?.args ?? [];
      expect(lastArgs(m1)).toEqual(expect.arrayContaining(["--resume", sessions[0]]));
      expect(lastArgs(m2)).toEqual(expect.arrayContaining(["--resume", sessions[1]]));
    });

    it("takes the woken members off the suspended tray, and leaves a minimized one minimized", async () => {
      const d = await open();
      const { ws, team, m1, m2 } = await teams(d);
      d.updateSettings({ suspendedAgentPlacement: "tray" });
      await suspendOne(d, ws, m1);
      await suspendOne(d, ws, m2);
      const view = () => d.runtime.deckStore.getSnapshot().viewByWs[ws.id];
      expect(view()?.suspendedTray).toEqual([m1, m2]);
      d.runtime.deckStore.dispatch({ type: "toggleMinimize", wsId: ws.id, paneId: m2 });
      expect(view()?.minimized).toEqual([m2]);
      await d.runtime.orchestrator.resumeTeam(ws.id, team);
      await host().until("both back, off the tray", () => d.slot(m1) === "live" && d.slot(m2) === "live" && view()?.suspendedTray === undefined, 15_000);
      expect(view()?.minimized).toEqual([m2]);
    });

    // A team suspended and asked back at once: the member last to stop was
    // still being suspended, and the machine refused it as busy.
    it("asks nobody back while a member's stop has not ended, and every one once it has — saying so to whoever renders it", async () => {
      const { d, ws, team, m1, m2 } = await slowToStop();
      await suspendOne(d, ws, m1);
      const told: (string | null)[] = [];
      const stop = d.runtime.orchestrator.subscribe(() => told.push(d.phase(m2)));
      await d.runtime.orchestrator.suspend(ws.id, m2);
      await host().until("still being suspended", () => d.phase(m2) === "suspending");
      expect(d.runtime.orchestrator.teamActs(ws.id, team)?.resume).toEqual({ take: [], skip: ["settling", "settling"] });
      const mark = d.intents().length;
      expect(await d.runtime.orchestrator.resumeTeam(ws.id, team)).toEqual([]);
      expect(d.intents().slice(mark)).toEqual([]);
      await host().until(`${m2} suspended`, () => d.phase(m2) === "suspended" && d.settled() && d.slot(m2) === "none", 15_000);
      // The last word its subscribers had is from after the stop ended: a
      // menu that rendered it offers the Resume now.
      expect(told[told.length - 1]).toBe("suspended");
      stop();
      expect(d.runtime.orchestrator.teamActs(ws.id, team)?.resume.take).toEqual([m1, m2]);
    });

    it("waits while a member it asked back is starting, and tells whoever renders it the moment that one is up", async () => {
      const d = await open();
      const { subscribeSessions } = await import("../ptyManager");
      const { ws, team, m1 } = await teams(d);
      await suspendOne(d, ws, m1);
      // The spawn's answer held: the process is still starting.
      const spawned = host().hold({ reply: "pty_open" });
      expect(await d.runtime.orchestrator.resumeTeam(ws.id, team)).toEqual([{ paneId: m1, outcome: { kind: "resuming" } }]);
      await spawned.caught;
      expect(d.slot(m1)).toBe("starting");
      expect(d.runtime.orchestrator.teamActs(ws.id, team)?.suspend.skip).toEqual(["settling", "settling", "settling"]);
      const told: string[] = [];
      const stopTelling = d.runtime.orchestrator.subscribe(() => told.push(d.slot(m1)));
      // Heard after the orchestrator hears the same change: whoever renders
      // the team's acts has been told by then, not at some later word from
      // the machine.
      let toldWhenUp: string[] | null = null;
      const stopWatching = subscribeSessions(() => {
        if (toldWhenUp === null && d.slot(m1) === "live") toldWhenUp = [...told];
      });
      spawned.release();
      await host().until(`${m1} up`, () => d.slot(m1) === "live", 15_000);
      stopWatching();
      stopTelling();
      expect(toldWhenUp).toContain("live");
      expect(d.runtime.orchestrator.teamActs(ws.id, team)?.suspend).toEqual({ take: expect.arrayContaining([m1]), skip: [] });
    });

    it("changes nothing on a team with nobody down", async () => {
      const d = await open();
      const { ws, team } = await teams(d);
      await host().until("settled", () => d.settled());
      const before = d.runtime.deckStore.getSnapshot().workspaces;
      const mark = d.intents().length;
      expect(await d.runtime.orchestrator.resumeTeam(ws.id, team)).toEqual([]);
      expect(d.runtime.deckStore.getSnapshot().workspaces).toBe(before);
      expect(d.intents().slice(mark)).toEqual([]);
    });
  });
});
