// @vitest-environment happy-dom
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Site } from "../../domain/lifecycle";
import { useHost } from "../../testing/host/host";
import { deckOnDisk, quitAfter, startDeck, type Deck } from "../../testing/host/deck";
import type { StubAgentControl } from "../../testing/host/stubPlugin";

/**
 * A wake and what overtakes it, end to end on the app itself: a request
 * that lands while the wake's folder is being probed or its plan built,
 * and panes asked for in a workspace that is not open.
 */
describe("wakes and the requests that overtake them, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const view = (d: Deck) => d.runtime.orchestrator.getView();
  const resumePlans = (d: Deck) => d.stub.plans.filter((plan) => plan.hook === "resume");
  const lastArgs = (d: Deck, paneId: string) => {
    const launches = d.launches(paneId);
    return launches[launches.length - 1]?.args ?? [];
  };
  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));

  /** An agent up, at `site` or the workspace root, its conversation on
   * disk; then the app quit and launched again — its boot wakes it as a
   * restore. */
  const restored = (site?: Site) =>
    quitAfter(
      host(),
      async (d) => {
        const ws = await d.workspaceUp();
        const team = site ? await d.teamUp("api", site) : undefined;
        const paneId = await d.addAgent({ role: "lead", ...(team !== undefined && { team }) });
        const session = await d.upAndBound(paneId);
        return { ws, paneId, session, launched: d.launches(paneId).length };
      },
      (onDisk, { session }) => onDisk.includes(session),
    );

  describe("a request that lands mid-flight", () => {
    it("serves a resume asked for while the boot's probe is out as the person's", async () => {
      const { paneId, session, launched } = await restored();
      const probing = host().hold({ request: "worktree_probe" });
      const d = await open({ rejectResumes: 1, liveRegistry: "none" });
      await probing.caught;
      expect(await d.runtime.orchestrator.resume(d.workspace().id, paneId)).toEqual({ kind: "resuming" });
      probing.release();
      await host().until("its resume ran, and was rejected", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "exited", 15_000);
      expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
      // The person's resume: a rejection is not quietly started over.
      expect(view(d).specs[paneId]?.resumeOrigin).toBe("manual");
      expect(d.runtime.orchestrator.recoverRejectedResume(d.workspace().id, paneId, 1)).toBe(false);
      await aWhile();
      expect(d.launches(paneId)).toHaveLength(launched + 1);
    });

    it("wakes a boot restore whose plan the agent could not build fresh — with nothing on its card", async () => {
      const { paneId, session, launched } = await restored();
      const d = await open({ resumePlanFails: "the plugin cannot open it" });
      await host().until("up, fresh", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      expect(lastArgs(d, paneId)).not.toContain("--resume");
      expect(d.stub.plans.map((plan) => plan.hook)).toEqual(["resume", "spawn"]);
      // Nobody asked for this wake: nothing is said on the card, and the
      // plan's failure does not stand in for the terminal.
      expect(view(d).wakeFailed).toEqual({});
      expect(view(d).planFailed.has(paneId)).toBe(false);
      await host().until("a new conversation bound", () => d.pane(paneId).session !== undefined && d.pane(paneId).session?.id !== session);
    });

    it("re-stamps a plan already being built as a restore when the ask lands mid-build — the hook runs once", async () => {
      const { paneId, launched } = await restored();
      const building = host().hold({ request: "bridge_pane_dir" });
      const d = await open();
      await building.caught;
      expect(await d.runtime.orchestrator.resume(d.workspace().id, paneId)).toEqual({ kind: "resuming" });
      building.release();
      await host().until("up", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      expect(resumePlans(d)).toHaveLength(1);
      expect(view(d).specs[paneId]?.resumeOrigin).toBe("manual");
      expect(d.pane(paneId).idle).toBeUndefined();
    });

    it("drops the outcome of a wake the person suspended while its folder was probed", async () => {
      const { paneId, launched } = await restored();
      const probing = host().hold({ request: "worktree_probe" });
      const d = await open();
      await probing.caught;
      expect(await d.runtime.orchestrator.suspend(d.workspace().id, paneId)).toEqual({ kind: "suspending" });
      await host().until("suspended", () => d.pane(paneId).idle?.reason === "suspended");
      probing.release();
      await aWhile();
      // No plan for a stopped pane, no process, and no failure explained.
      expect(resumePlans(d)).toEqual([]);
      expect(d.launches(paneId)).toHaveLength(launched);
      expect(d.pane(paneId).idle).toMatchObject({ reason: "suspended" });
      expect(view(d).wakeFailed).toEqual({});
    });

    it("does not block a pane the person suspended while its gone folder was probed", async () => {
      const folder = join(host().work, "api");
      mkdirSync(folder);
      const { paneId } = await restored({ kind: "existing", cwd: folder });
      const probing = host().hold({ request: "worktree_probe" });
      const d = await open();
      await probing.caught;
      // The folder goes while the probe is on its way, and the person stops
      // the agent: the probe finds nothing there.
      rmSync(folder, { recursive: true, force: true });
      expect(await d.runtime.orchestrator.suspend(d.workspace().id, paneId)).toEqual({ kind: "suspending" });
      await host().until("suspended", () => d.pane(paneId).idle?.reason === "suspended");
      probing.release();
      await aWhile();
      expect(view(d).blocked).toEqual({});
      expect(d.pane(paneId).idle).toMatchObject({ reason: "suspended" });
    });
  });

  describe("a pane asked for in a workspace that is not open", () => {
    /** Two workspaces, the first open; in the second an agent — at `site`,
     * or its root — up and bound, then suspended. */
    async function offScreen(d: Deck, site?: Site) {
      const one = await d.workspaceUp();
      const two = await d.anotherWorkspace("two", host().trees);
      const team = site ? await d.teamUp("api", site, two) : undefined;
      const paneId = await d.addAgent({ role: "lead", workspace: two, ...(team !== undefined && { team }) });
      const session = await d.upAndBound(paneId);
      expect(await d.runtime.orchestrator.suspend(two.id, paneId)).toEqual({ kind: "suspending" });
      await host().until("suspended", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none", 15_000);
      d.runtime.deckStore.dispatch({ type: "selectWorkspace", id: one.id });
      await host().until("the first one open", () => d.runtime.deckStore.getSnapshot().activeId === one.id);
      return { one, two, paneId, session, launched: d.launches(paneId).length };
    }
    const activeId = (d: Deck) => d.runtime.deckStore.getSnapshot().activeId;

    it("is served where it stands: it starts there, in its conversation, and the open workspace stays open", async () => {
      const d = await open();
      const { one, two, paneId, session, launched } = await offScreen(d);
      expect(await d.runtime.orchestrator.resume(two.id, paneId)).toEqual({ kind: "resuming" });
      await host().until("up off screen", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
      expect(d.pane(paneId).idle).toBeUndefined();
      expect(activeId(d)).toBe(one.id);
    });

    it("starts the pane it restarts, once the machine has let go of its process", async () => {
      const d = await open();
      const { two, paneId, launched } = await offScreen(d);
      await d.runtime.orchestrator.resume(two.id, paneId);
      await host().until("up off screen", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      expect((await d.runtime.orchestrator.restart(two.id, paneId, "fresh")).kind).toBe("accepted");
      await host().until("restarted off screen", () => d.launches(paneId).length === launched + 2 && d.slot(paneId) === "live", 15_000);
      expect(lastArgs(d, paneId)).not.toContain("--resume");
    });

    it("owes it no start once it has had its process: an exit then starts nothing", async () => {
      const d = await open();
      const { two, paneId, launched } = await offScreen(d);
      await d.runtime.orchestrator.resume(two.id, paneId);
      await host().until("up off screen", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live", 15_000);
      d.type(paneId, "exit 0");
      await host().until("its agent ended", () => d.slot(paneId) === "exited");
      await aWhile();
      expect(d.launches(paneId)).toHaveLength(launched + 1);
    });

    it("owes it no start once its wake gives up — asked again, it starts", async () => {
      const d = await open();
      const folder = join(host().trees, "api");
      mkdirSync(folder);
      const { two, paneId, launched } = await offScreen(d, { kind: "existing", cwd: folder });
      rmSync(folder, { recursive: true, force: true });
      expect(await d.runtime.orchestrator.resume(two.id, paneId)).toEqual({ kind: "resuming" });
      // Put back where it came from, not left rising — by the machine, whose
      // flag the suspension is.
      await host().until("its folder is gone, and it is put back", () => view(d).blocked[paneId] === folder && d.phase(paneId) === "suspended" && d.pane(paneId).idle?.reason === "suspended", 15_000);
      // The folder comes back, and the deck moves on: nothing has asked for
      // the pane since, so nothing starts it.
      mkdirSync(folder);
      d.runtime.deckStore.dispatch({ type: "renameTeam", wsId: two.id, teamId: d.pane(paneId).team?.teamId ?? "", name: "api again" });
      await aWhile();
      expect(d.launches(paneId)).toHaveLength(launched);
      // Asked again, it starts — off screen all the same.
      expect((await d.runtime.orchestrator.startFresh(two.id, paneId)).kind).toBe("accepted");
      await host().until("started fresh off screen", () => d.launches(paneId).length === launched + 1 && d.slot(paneId) === "live" && d.phase(paneId) === "live", 15_000);
    });

    it("leaves a pane its boot restores alone in a workspace that is not open", async () => {
      const { paneId } = await quitAfter(
        host(),
        async (d) => {
          const one = await d.workspaceUp();
          const two = await d.anotherWorkspace("two", host().trees);
          const pane = await d.addAgent({ role: "lead", workspace: two });
          const session = await d.upAndBound(pane);
          d.runtime.deckStore.dispatch({ type: "selectWorkspace", id: one.id });
          return { one, paneId: pane, session };
        },
        (onDisk, { one, session }) => onDisk.includes(session) && onDisk.includes(`"activeId":"${one.id}"`),
      );
      const d = await open();
      const before = d.launches(paneId).length;
      await host().until("the machine has settled", () => d.settled());
      await aWhile();
      // Waking a whole background workspace at launch is what the economy
      // exists to prevent.
      expect(d.launches(paneId)).toHaveLength(before);
      expect(resumePlans(d)).toEqual([]);
      expect(d.pane(paneId).idle).toEqual({ reason: "waking", origin: "restore" });
    });
  });

  it("refuses to resume a pane no plugin can start, and leaves it as it was", async () => {
    const { paneId } = await quitAfter(
      host(),
      async (d) => {
        const { ws, paneId: pane, session } = await d.agentUp();
        expect(await d.runtime.orchestrator.suspend(ws.id, pane)).toEqual({ kind: "suspending" });
        await host().until("suspended", () => d.phase(pane) === "suspended" && d.settled() && d.slot(pane) === "none", 15_000);
        return { paneId: pane, session };
      },
      (onDisk, { session }) => onDisk.includes(session) && onDisk.includes('"reason":"suspended"'),
      // The agent's plugin is gone by the next launch: its panes name an
      // agent nothing provides.
      () => writeFileSync(join(host().home, "deck.json"), deckOnDisk(host()).split('"agentType":"stub"').join('"agentType":"retired-cli"')),
    );
    const d = await open();
    const before = d.pane(paneId).idle;
    expect(before).toMatchObject({ reason: "suspended" });
    expect(await d.runtime.orchestrator.resume(d.workspace().id, paneId)).toEqual({ kind: "blocked", why: "unavailable" });
    expect(d.pane(paneId).idle).toEqual(before);
  });
});
