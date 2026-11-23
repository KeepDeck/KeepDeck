// @vitest-environment happy-dom
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { callsOf, useHost } from "../../testing/host/host";
import { quitAfter, retireOnDisk, startDeck, type Deck, type DeckStart } from "../../testing/host/deck";
import type { StubAgentControl } from "../../testing/host/stubPlugin";

/**
 * Which agents rise, and when, end to end on the app itself: the economy of
 * a workspace nobody has opened, the launch policy, a folder that went, an
 * archive — and what the page answers when asked whether an agent would
 * read something sent now.
 */
describe("which agents rise, and when, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}, start: DeckStart = {}) => (deck = await startDeck(host(), told, start));
  const view = (d: Deck) => d.runtime.orchestrator.getView();
  const reach = (d: Deck, paneId: string) => d.runtime.orchestrator.reachOf(paneId);
  const activeId = (d: Deck) => d.runtime.deckStore.getSnapshot().activeId;
  const lastArgs = (d: Deck, paneId: string) => {
    const launches = d.launches(paneId);
    return launches[launches.length - 1]?.args ?? [];
  };
  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));
  /** The control for "nothing starts": a member raised beside `of`, in the
   * open workspace, goes through every step a start would — the passes, its
   * plan, its lease, its open. Once it runs, a start decided before it would
   * have gone out. */
  const raisedBeside = (d: Deck, of: string) => d.memberUp(d.pane(of).team?.teamId ?? "", "impl-1");
  const probedSince = (mark: number) => callsOf(host(), "worktree_probe", mark);
  const select = async (d: Deck, ws: WorkspaceRef) => {
    d.runtime.deckStore.dispatch({ type: "selectWorkspace", id: ws.id });
    await host().until(`${ws.id} open`, () => activeId(d) === ws.id);
  };
  const settingsOnDisk = () => {
    const file = join(host().home, "settings.json");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };

  /** Two workspaces, the first open with an agent up in it; an agent asked
   * for in the second while nobody has it open. */
  async function oneOpen(d: Deck) {
    const one = await d.workspaceUp();
    const here = await d.addAgent({ role: "lead" });
    await d.upAndBound(here);
    const two = await d.anotherWorkspace("two", host().trees);
    await select(d, one);
    const there = await d.addAgent({ role: "lead", workspace: two });
    await host().until(`${there} is on the deck`, () => d.runtime.deckStore.getSnapshot().workspaces.some((ws) => ws.panes.some((pane) => pane.id === there)));
    return { one, two, here, there };
  }

  /** Two workspaces with an agent up and bound in each, the first open;
   * then the app quit and launched again — `andThen` done before the quit. */
  const restoredInTwo = (andThen?: (d: Deck) => void, saved: (onDisk: string) => boolean = () => true) =>
    quitAfter(
      host(),
      async (d) => {
        const one = await d.workspaceUp();
        const here = await d.addAgent({ role: "lead" });
        const hereSession = await d.upAndBound(here);
        const two = await d.anotherWorkspace("two", host().trees);
        const there = await d.addAgent({ role: "lead", workspace: two });
        const thereSession = await d.upAndBound(there);
        await select(d, one);
        andThen?.(d);
        return { one, two, here, there, sessions: [hereSession, thereSession] };
      },
      (onDisk, { one, sessions }) => sessions.every((id) => onDisk.includes(id)) && onDisk.includes(`"activeId":"${one.id}"`) && saved(onDisk),
    );

  describe("a workspace nobody has open", () => {
    it("starts the agent on screen and leaves the one in a workspace nobody has opened alone", async () => {
      const d = await open();
      const { here, there } = await oneOpen(d);
      await raisedBeside(d, here);
      expect(d.launches(there)).toEqual([]);
      expect(reach(d, there)).toEqual({ kind: "down", why: "workspace-closed" });
      expect(reach(d, here)).toEqual({ kind: "running" });
    });

    it("starts the other one when its workspace is opened, and only then", async () => {
      const d = await open();
      const { two, here, there } = await oneOpen(d);
      await raisedBeside(d, here);
      expect(d.launches(there)).toEqual([]);
      await select(d, two);
      await host().until("it rises as its workspace opens", () => d.launches(there).length === 1 && d.slot(there) === "live", 15_000);
    });

    it("starts no second process for an agent that has one, whatever the deck does", async () => {
      const d = await open();
      const { one, here } = await oneOpen(d);
      d.runtime.deckStore.dispatch({ type: "renameTeam", wsId: one.id, teamId: d.pane(here).team?.teamId ?? "", name: "renamed" });
      await raisedBeside(d, here);
      expect(d.launches(here)).toHaveLength(1);
    });

    it("wakes the agents its boot restores lazily: the open workspace's at launch, the other's on its first opening", async () => {
      const { two, here, there } = await restoredInTwo();
      const d = await open();
      await host().until("the open one rises", () => d.slot(here) === "live", 15_000);
      await aWhile();
      expect(d.pane(there).idle).toEqual({ reason: "waking", origin: "restore" });
      await select(d, two);
      await host().until("the other rises as its workspace opens", () => d.slot(there) === "live" && d.pane(there).idle === undefined, 15_000);
    });
  });

  describe("the launch policy", () => {
    it("stops raising agents the moment it says so — parked, not even probed — and leaves the running one alone", async () => {
      const { two, here, there } = await restoredInTwo();
      const d = await open();
      await host().until("the open one rises", () => d.slot(here) === "live", 15_000);
      expect(d.pane(there).idle).toEqual({ reason: "waking", origin: "restore" });
      // The person turns the policy on, then opens the other workspace.
      d.updateSettings({ parkAgentsOnLaunch: true });
      const mark = host().tape.length;
      await select(d, two);
      await host().until("parked", () => d.pane(there).idle?.reason === "parked");
      await aWhile();
      expect(probedSince(mark)).toEqual([]);
      expect(d.slot(there)).toBe("none");
      // A preference changing does not reach back for a live agent.
      expect(d.slot(here)).toBe("live");
      expect(d.pane(here).idle).toBeUndefined();
    });

    it("still serves a resume the person asks for while it is on", async () => {
      const { two, there, sessions } = await restoredInTwo();
      const d = await open();
      d.updateSettings({ parkAgentsOnLaunch: true });
      await select(d, two);
      await host().until("parked", () => d.pane(there).idle?.reason === "parked");
      const launched = d.launches(there).length;
      expect(await d.runtime.orchestrator.resume(two.id, there)).toEqual({ kind: "resuming" });
      await host().until("it rises by the person's ask", () => d.launches(there).length === launched + 1 && d.slot(there) === "live", 15_000);
      expect(lastArgs(d, there)).toEqual(expect.arrayContaining(["--resume", sessions[1]]));
    });

    it("keeps the agents it parked at launch parked through a workspace switch", async () => {
      const { two, here, there } = await restoredInTwo(
        (d) => d.updateSettings({ parkAgentsOnLaunch: true }),
        () => settingsOnDisk().includes('"parkAgentsOnLaunch":true'),
      );
      const mark = host().tape.length;
      const d = await open();
      await host().until("both parked", () => d.pane(here).idle?.reason === "parked" && d.pane(there).idle?.reason === "parked", 15_000);
      await select(d, two);
      await aWhile();
      expect(d.pane(here).idle).toEqual({ reason: "parked" });
      expect(d.pane(there).idle).toEqual({ reason: "parked" });
      expect(probedSince(mark)).toEqual([]);
    });
  });

  describe("a resume that cannot be served", () => {
    /** An agent up in a team at a folder of its own, then suspended. */
    async function suspendedAt(d: Deck) {
      const folder = join(host().work, "api");
      mkdirSync(folder);
      const ws = await d.workspaceUp();
      const team = await d.teamUp("api", { kind: "existing", cwd: folder });
      const paneId = await d.addAgent({ role: "lead", team });
      const session = await d.upAndBound(paneId);
      expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
      await host().until("suspended", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none", 15_000);
      return { ws, team, paneId, session, folder, suspended: d.pane(paneId).idle, launched: d.launches(paneId).length };
    }
    /** Put back down as it was, as the deck and the machine both say. */
    const putBack = (d: Deck, paneId: string) => d.phase(paneId) === "suspended" && d.settled() && d.pane(paneId).idle?.reason === "suspended";

    it("looks again when the folder comes back, and the agent resumes into its conversation", async () => {
      const d = await open();
      const { ws, paneId, session, folder, suspended, launched } = await suspendedAt(d);
      rmSync(folder, { recursive: true, force: true });
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await host().until("its folder is gone, and it is put back down", () => view(d).blocked[paneId] === folder && putBack(d, paneId), 15_000);
      // Back as it was, its own date kept: the failed resume decided nothing.
      expect(d.pane(paneId).idle).toEqual(suspended);
      mkdirSync(folder);
      expect(await d.runtime.orchestrator.resume(ws.id, paneId)).toEqual({ kind: "resuming" });
      await host().until("back", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      expect(view(d).blocked[paneId]).toBeUndefined();
      expect(d.pane(paneId).idle).toBeUndefined();
      expect(d.pane(paneId).session?.id).toBe(session);
      // Into its own conversation, in its team's folder.
      expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
      expect(d.launches(paneId)[launched]?.cwd).toBe(folder);
    });

    it("stays blocked, keeping its conversation, while the folder is still gone", async () => {
      const d = await open();
      const { ws, paneId, session, folder, launched } = await suspendedAt(d);
      rmSync(folder, { recursive: true, force: true });
      const mark = host().tape.length;
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await host().until("put back down", () => view(d).blocked[paneId] === folder && putBack(d, paneId), 15_000);
      expect(await d.runtime.orchestrator.resume(ws.id, paneId)).toEqual({ kind: "resuming" });
      await host().until("blocked again, and put back down", () => view(d).blocked[paneId] === folder && putBack(d, paneId), 15_000);
      expect(d.pane(paneId).session?.id).toBe(session);
      expect(d.launches(paneId)).toHaveLength(launched);
      // Its folder looked at once for each ask — never again on its own.
      await aWhile();
      expect(probedSince(mark)).toEqual([{ path: folder }, { path: folder }]);
    });

    it("puts back down a resume its agent could not plan — once — and serves the next one", async () => {
      const d = await open();
      const { ws, paneId, suspended, launched } = await suspendedAt(d);
      d.stub.resumePlanFails = "the plugin cannot open it";
      // The machine's put-back is slow to land: until it does, the pane
      // still reads as rising.
      const landing = host().hold({ heard: '"kind":"markSuspended"' });
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await landing.caught;
      await aWhile();
      // No second attempt while it is being put back.
      expect(d.stub.plans.filter((plan) => plan.hook === "resume")).toHaveLength(1);
      landing.release();
      await host().until("its card says why, and it is put back down", () => view(d).wakeFailed[paneId] !== undefined && putBack(d, paneId), 15_000);
      expect(d.pane(paneId).idle).toEqual(suspended);
      d.stub.resumePlanFails = null;
      expect(await d.runtime.orchestrator.resume(ws.id, paneId)).toEqual({ kind: "resuming" });
      await host().until("back", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      // Asking again cleared what its card said of the last one.
      expect(view(d).wakeFailed[paneId]).toBeUndefined();
    });

    it("leaves a resume put back down where it rose, its card saying why — not on the tray its person keeps suspended agents on", async () => {
      const d = await open();
      d.updateSettings({ suspendedAgentPlacement: "tray" });
      const { ws, paneId, folder } = await suspendedAt(d);
      const tray = () => d.runtime.deckStore.getSnapshot().viewByWs[ws.id]?.suspendedTray ?? [];
      expect(tray()).toEqual([paneId]);
      rmSync(folder, { recursive: true, force: true });
      // Resumed from the tray: it leaves the tray as it rises.
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await host().until("put back down", () => view(d).blocked[paneId] === folder && putBack(d, paneId), 15_000);
      expect(tray()).toEqual([]);
      // A Suspend the person makes still goes to the tray.
      mkdirSync(folder);
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await host().until("back", () => d.slot(paneId) === "live", 15_000);
      expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
      await host().until("on the tray", () => putBack(d, paneId) && tray().includes(paneId), 15_000);
    });

    it("starts fresh a suspended agent whose folder is gone through the machine: what it brings up can be suspended again", async () => {
      const d = await open();
      const { ws, team, paneId, session, folder, launched } = await suspendedAt(d);
      rmSync(folder, { recursive: true, force: true });
      await d.runtime.orchestrator.resume(ws.id, paneId);
      await host().until("put back down", () => view(d).blocked[paneId] === folder && putBack(d, paneId), 15_000);
      // Its card offers a fresh start in the workspace's own folder — on a
      // team made there, as none works at the root yet.
      expect((await d.runtime.orchestrator.startFresh(ws.id, paneId)).kind).toBe("accepted");
      await host().until("up fresh, and the machine says so", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live" && d.phase(paneId) === "live", 15_000);
      // A new conversation, in the workspace's folder: the old one dropped.
      expect(lastArgs(d, paneId)).not.toContain("--resume");
      expect(d.launches(paneId)[launched]?.cwd).toBe(host().work);
      expect(d.pane(paneId).session?.id).not.toBe(session);
      // A team of its own at the root; the one whose folder went keeps its card.
      expect(d.pane(paneId).team?.teamId).not.toBe(team);
      expect(d.workspace().teams?.map((row) => row.id)).toEqual(expect.arrayContaining([team, d.pane(paneId).team?.teamId]));
      expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
      await host().until("suspended again", () => putBack(d, paneId) && d.slot(paneId) === "none", 15_000);
    });
  });

  describe("whether an agent would read something sent now", () => {
    it("answers from the same facts the sweep acts on", async () => {
      const { here, there, sleeper, orphan } = await quitAfter(
        host(),
        async (d) => {
          const one = await d.workspaceUp();
          const running = await d.addAgent({ role: "lead" });
          await d.upAndBound(running);
          const suspended = await d.addAgent({ role: "impl-1" });
          await d.upAndBound(suspended);
          expect(await d.runtime.orchestrator.suspend(one.id, suspended)).toEqual({ kind: "suspending" });
          await host().until("suspended", () => d.phase(suspended) === "suspended" && d.settled() && d.slot(suspended) === "none", 15_000);
          const lost = await d.addAgent({ role: "reviewer-1" });
          await d.upAndBound(lost);
          const two = await d.anotherWorkspace("two", host().trees);
          const away = await d.addAgent({ role: "lead", workspace: two });
          await d.upAndBound(away);
          await select(d, one);
          return { one, here: running, sleeper: suspended, orphan: lost, there: away };
        },
        (onDisk, { one }) => onDisk.includes(`"activeId":"${one.id}"`) && onDisk.includes('"reason":"suspended"'),
        ({ orphan: lost }) => retireOnDisk(host(), lost),
      );
      const d = await open();
      await host().until("the open one rises", () => d.slot(here) === "live", 15_000);
      expect(reach(d, here)).toEqual({ kind: "running" });
      // The member of a suspended team: the case that started this.
      expect(reach(d, sleeper)).toEqual({ kind: "down", why: "suspended" });
      expect(reach(d, orphan)).toEqual({ kind: "down", why: "agent-unavailable" });
      expect(reach(d, there)).toEqual({ kind: "down", why: "workspace-closed" });
      expect(reach(d, "pane-999")).toBeNull();
    });

    it("does not call an agent's plugin missing before the catalog has loaded", async () => {
      const { orphan } = await quitAfter(
        host(),
        async (d) => ({ orphan: (await d.agentUp()).paneId }),
        (onDisk, { orphan: pane }) => onDisk.includes(`"id":"${pane}"`),
        ({ orphan: lost }) => retireOnDisk(host(), lost),
      );
      // The plugins have not loaded yet: nothing can say the agent is gone.
      const loading = host().hold({ request: "plugin_permissions_resolve" });
      const d = await open({}, { waitForPlugins: false });
      await loading.caught;
      expect(reach(d, orphan)).toEqual({ kind: "starting" });
      loading.release();
      await host().until("then it is", () => reach(d, orphan)?.kind === "down", 15_000);
      expect(reach(d, orphan)).toEqual({ kind: "down", why: "agent-unavailable" });
    });
  });

  describe("an archive", () => {
    it("starts nothing in an archived workspace — not even a resume asked for by name", async () => {
      const d = await open();
      const { two, there } = await oneOpen(d);
      // The agent's seat is over before the archive is asked for.
      await host().until("settled", () => d.settled());
      expect((await d.runtime.orchestrator.archive(two)).kind).toBe("accepted");
      await host().until("put away", () => d.runtime.deckStore.getSnapshot().workspaces.find((ws) => ws.id === two.id)?.archived?.phase === "archived", 15_000);
      const idle = d.pane(there).idle;
      expect(await d.runtime.orchestrator.resume(two.id, there)).toEqual({ kind: "blocked", why: "archived" });
      expect(d.pane(there).idle).toEqual(idle);
      expect(reach(d, there)).toEqual({ kind: "down", why: "workspace-archived" });
      await aWhile();
      expect(d.launches(there)).toEqual([]);
      // No plan is even built there: a plan's delivery arms the folder.
      expect(view(d).specs[there]).toBeUndefined();
    });

    it("reads a running agent down the moment its workspace is archived, while its process still runs", async () => {
      // An agent slow to stop: the archive's stop takes it down only by the
      // kill, so its process outlives the archive's marker.
      const d = await open({ deaf: true });
      const { ws, paneId } = await d.agentUp();
      expect(reach(d, paneId)).toEqual({ kind: "running" });
      expect((await d.runtime.orchestrator.archive(ws)).kind).toBe("accepted");
      await host().until("marked archived", () => d.workspace().archived !== undefined);
      expect(d.slot(paneId)).toBe("live");
      expect(reach(d, paneId)).toEqual({ kind: "down", why: "workspace-archived" });
    });
  });
});
