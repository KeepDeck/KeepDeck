// @vitest-environment happy-dom
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callsOf, useHost } from "../../testing/host/host";
import { bindOnDisk, quitAfter, retireOnDisk, startDeck, type Deck, type DeckStart } from "../../testing/host/deck";
import type { StubAgentControl } from "../../testing/host/stubPlugin";

/**
 * How the page brings an agent up, end to end on the app itself: what it
 * waits for — the machine's barrier, the plugins — what a restored agent
 * comes back as, what holds one down — a folder still being made or gone,
 * an agent nothing provides, a suspension — and what a fresh start carries.
 */
describe("how an agent comes up, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}, start: DeckStart = {}) => (deck = await startDeck(host(), told, start));
  const view = (d: Deck) => d.runtime.orchestrator.getView();
  const aWhile = () => new Promise((resolve) => setTimeout(resolve, 500));
  // A pane's launches are every process started for it on this home: the
  // launch before the relaunch's first among them.
  /** The marker a boot restore leaves on a pane until it is up. */
  const restoring = { reason: "waking", origin: "restore" };

  /** An agent up and bound on a team at a folder of its own. */
  async function inFolder(d: Deck) {
    const folder = join(host().work, "api");
    mkdirSync(folder);
    const ws = await d.workspaceUp();
    const team = await d.teamUp("api", { kind: "existing", cwd: folder });
    const paneId = await d.addAgent({ role: "lead", team });
    return { ws, team, paneId, folder, session: await d.upAndBound(paneId) };
  }

  /** One agent up and bound, and the app quit and launched again. */
  const restoredOne = (meanwhile?: (made: { paneId: string }) => void) =>
    quitAfter(host(), (d) => d.agentUp(), (onDisk, { session }) => onDisk.includes(session), meanwhile);

  /** An agent on a team at a folder of its own, restored after the folder
   * went while the app was down. */
  const goneWhileDown = () =>
    quitAfter(host(), inFolder, (onDisk, { session }) => onDisk.includes(session), ({ folder }) => rmSync(folder, { recursive: true, force: true }));

  it("starts nothing while the machine's barrier is up — not even a lease — and the agent once it lifts", async () => {
    const { paneId } = await restoredOne();
    // The machine has not reconciled the deck yet: its handshake is held.
    const booting = host().hold({ request: "lifecycle_boot_handshake" });
    const mark = host().tape.length;
    const d = await open({}, { waitForOpen: false });
    await booting.caught;
    await aWhile();
    expect(callsOf(host(), "lifecycle_lease", mark)).toEqual([]);
    expect(d.launches(paneId)).toHaveLength(1);
    booting.release();
    await host().until("it rises once the barrier lifts", () => d.slot(paneId) === "live", 15_000);
    expect(callsOf(host(), "lifecycle_lease", mark)).toHaveLength(1);
  });

  it("resumes a restored agent into the conversation it recorded, in its team's folder, leased there as its own — and shows its plan", async () => {
    const { ws, paneId, folder, session } = await quitAfter(host(), inFolder, (onDisk, made) => onDisk.includes(made.session));
    const mark = host().tape.length;
    const d = await open();
    await host().until("it rises", () => d.slot(paneId) === "live" && d.pane(paneId).idle === undefined, 15_000);
    // The binding it recorded is trusted: no store is read, no other
    // conversation chosen.
    expect(d.launches(paneId)).toHaveLength(2);
    expect(d.launches(paneId)[1]).toMatchObject({ args: expect.arrayContaining(["--resume", session]), cwd: folder });
    expect(d.stub.plans.filter((plan) => plan.hook === "resume").map((plan) => plan.input)).toEqual([
      expect.objectContaining({ paneId, sessionId: session, cwd: folder, workspace: { id: ws.id, instance: d.workspace().instance } }),
    ]);
    expect(callsOf(host(), "lifecycle_lease", mark)).toEqual([{ lease: { kind: "launch", workspace: ws.id, owner: { kind: "pane", pane: paneId }, dir: folder } }]);
    // Its plan is published: the deck mounts a terminal for it.
    expect(view(d).specs[paneId]).toMatchObject({ resumeOf: session });
  });

  it("wakes an agent that never bound a conversation fresh — never into the one another agent in its folder had", async () => {
    const { lone } = await quitAfter(
      host(),
      async (d) => {
        const { session } = await d.agentUp();
        // Its agent reports nothing: it never binds a conversation.
        d.stub.unbound = true;
        const lone = await d.addAgent({ role: "impl-1" });
        await host().until("its process is up", () => d.slot(lone) === "live", 15_000);
        return { session, lone };
      },
      (onDisk, { session, lone }) => onDisk.includes(session) && onDisk.includes(`"id":"${lone}"`),
    );
    const d = await open();
    await host().until("it rises", () => d.slot(lone) === "live" && d.pane(lone).idle === undefined, 15_000);
    expect(d.launches(lone)).toHaveLength(2);
    expect(d.launches(lone)[1]?.args).not.toContain("--resume");
    expect(d.stub.plans.filter((plan) => plan.hook === "resume" && plan.input.paneId === lone)).toEqual([]);
  });

  it("wakes an agent on another machine fresh: no folder looked at, no conversation resumed, its launch leased as the remote's own", async () => {
    const { paneId } = await quitAfter(
      host(),
      async (d) => {
        await d.workspaceUp();
        const paneId = await d.addAgent({ role: "lead", endpoint: "ws://vps:4500" });
        await host().until("its thin client is up", () => d.slot(paneId) === "live", 15_000);
        return { paneId };
      },
      (onDisk, made) => onDisk.includes(`"id":"${made.paneId}"`),
      // A binding no remote agent takes: a stale one, written while the app
      // is down.
      (made) => bindOnDisk(host(), made.paneId, "stale"),
    );
    const mark = host().tape.length;
    const d = await open();
    await host().until("it rises", () => d.slot(paneId) === "live" && d.pane(paneId).idle === undefined, 15_000);
    expect(d.launches(paneId)).toHaveLength(2);
    expect(d.launches(paneId)[1]?.args).not.toContain("--resume");
    expect(callsOf(host(), "worktree_probe", mark)).toEqual([]);
    expect(callsOf(host(), "lifecycle_lease", mark)).toEqual([{ lease: { kind: "launch", workspace: d.workspace().id, owner: { kind: "remote", pane: paneId }, dir: null } }]);
  });

  it("neither looks at nor starts a restored agent whose team's worktree is still being made — and starts it there once it stands", async () => {
    const first = await open();
    first.gitRepo();
    await first.workspaceUp();
    const settling = host().hold({ heard: '"kind":"settleTeam"' });
    const paneId = await first.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } });
    await settling.caught;
    first.dispose();
    deck = null;
    await host().relaunch("crash");
    // The next launch lands the team in the worktree it finds: held there.
    const landing = host().hold({ heard: '"kind":"settleTeam"' });
    const mark = host().tape.length;
    const d = await open();
    await landing.caught;
    await aWhile();
    expect(d.pane(paneId).idle).toEqual(restoring);
    expect(callsOf(host(), "worktree_probe", mark)).toEqual([]);
    expect(d.launches(paneId)).toEqual([]);
    landing.release();
    await host().until("it starts in the worktree", () => d.slot(paneId) === "live", 15_000);
    expect(d.launches(paneId)[0]?.cwd).not.toBe(host().work);
  });

  it("leaves an agent no plugin provides waking, its conversation kept and its folder not looked at", async () => {
    const { paneId, session } = await restoredOne(({ paneId: retired }) => retireOnDisk(host(), retired));
    const mark = host().tape.length;
    const d = await open();
    await aWhile();
    expect(d.pane(paneId).idle).toEqual(restoring);
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(callsOf(host(), "worktree_probe", mark)).toEqual([]);
    expect(d.launches(paneId)).toHaveLength(1);
  });

  it("wakes nothing before the plugins have loaded, and the agent once they have", async () => {
    const { paneId } = await restoredOne();
    const loading = host().hold({ request: "plugin_permissions_resolve" });
    const mark = host().tape.length;
    const d = await open({}, { waitForPlugins: false });
    await loading.caught;
    await aWhile();
    expect(d.pane(paneId).idle).toEqual(restoring);
    expect(callsOf(host(), "worktree_probe", mark)).toEqual([]);
    loading.release();
    await host().until("it rises once they have", () => d.slot(paneId) === "live", 15_000);
  });

  it("holds a restored agent whose folder went on its card: not started, and its folder looked at once", async () => {
    const { paneId, folder, session } = await goneWhileDown();
    const mark = host().tape.length;
    const d = await open();
    await host().until("its card says its folder is gone", () => view(d).blocked[paneId] === folder, 15_000);
    await aWhile();
    expect(d.pane(paneId).idle).toEqual(restoring);
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(d.launches(paneId)).toHaveLength(1);
    expect(callsOf(host(), "worktree_probe", mark)).toEqual([{ path: folder }]);
  });

  it("forgets a held agent's card once the agent is closed", async () => {
    const { ws, paneId, folder } = await goneWhileDown();
    const d = await open();
    await host().until("its card says its folder is gone", () => view(d).blocked[paneId] === folder, 15_000);
    const workspace = { id: ws.id, instance: d.workspace().instance };
    const consent = await d.consentFor({ kind: "closeAgent", workspace: ws.id, pane: paneId, consent: { stops: [], folders: [], tickets: [] } });
    expect((await d.runtime.orchestrator.close({ kind: "agent", workspace, paneId, consent })).kind).toBe("accepted");
    await host().until("the agent and its card are gone", () => !d.workspace().panes.some((pane) => pane.id === paneId) && view(d).blocked[paneId] === undefined, 15_000);
  });

  it("starts nothing fresh in an archived workspace: the agent keeps its team and its conversation", async () => {
    const { ws, team, paneId, folder, session } = await goneWhileDown();
    const d = await open();
    await host().until("its card says its folder is gone", () => view(d).blocked[paneId] === folder, 15_000);
    expect((await d.runtime.orchestrator.archive({ id: ws.id, instance: d.workspace().instance })).kind).toBe("accepted");
    // Put away, as the deck and the machine both say: the archive is over.
    await host().until("put away", () => d.workspace().archived?.phase === "archived" && d.workspacePhase() === "archived", 15_000);
    // The machine refuses the move — with no team at the root to land on, as
    // with one; the page writes nothing of its own around the refusal.
    expect(await d.runtime.orchestrator.startFresh(ws.id, paneId)).toMatchObject({ kind: "refused", refusal: { kind: "archived" } });
    await aWhile();
    expect(d.pane(paneId).team?.teamId).toBe(team);
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(d.launches(paneId)).toHaveLength(1);
  });

  it("starts fresh carrying the agent's own role — at the next number where its number is held — refused where it cannot stand, saying why, and under the role the person picks then", async () => {
    const folder = join(host().work, "service");
    const { ws, root, lead, impl } = await quitAfter(
      host(),
      async (d) => {
        const { ws } = await d.agentUp();
        const root = d.workspace().teams?.[0]?.id ?? "";
        await d.memberUp(root, "impl-1");
        mkdirSync(folder);
        const service = await d.teamUp("service", { kind: "existing", cwd: folder });
        const lead = await d.addAgent({ role: "lead", team: service });
        await d.upAndBound(lead);
        return { ws, root, lead, impl: await d.memberUp(service, "impl-1") };
      },
      (onDisk, made) => onDisk.includes(`"id":"${made.impl}"`),
      () => rmSync(folder, { recursive: true, force: true }),
    );
    const d = await open();
    await host().until("both held on their card", () => view(d).blocked[lead] === folder && view(d).blocked[impl] === folder, 15_000);
    // Its own role carried: impl-1 is held on the root's team, so it lands
    // as impl-2 there.
    expect((await d.runtime.orchestrator.startFresh(ws.id, impl)).kind).toBe("accepted");
    await host().until("on the root's team", () => d.pane(impl).team?.teamId === root, 15_000);
    expect(d.pane(impl).team).toEqual({ teamId: root, role: "impl-2" });
    // A lead cannot join a team that has one: it stays where it is, and its
    // card says why.
    const own = d.pane(lead).team;
    const session = d.pane(lead).session?.id;
    expect((await d.runtime.orchestrator.startFresh(ws.id, lead)).kind).toBe("refused");
    expect(view(d).wakeFailed[lead]).toContain('role "lead" is taken');
    expect(d.pane(lead).team).toEqual(own);
    expect(d.pane(lead).session?.id).toBe(session);
    // Then under the role the person picks.
    expect((await d.runtime.orchestrator.startFresh(ws.id, lead, "reviewer-1")).kind).toBe("accepted");
    await host().until("on the root's team, as picked", () => d.pane(lead).team?.teamId === root, 15_000);
    expect(d.pane(lead).team).toEqual({ teamId: root, role: "reviewer-1" });
  });

  it("leaves a suspended agent down across a relaunch — not started, its folder not looked at — until it is asked back", async () => {
    const { paneId } = await quitAfter(
      host(),
      async (d) => {
        const { ws, paneId: suspended } = await d.agentUp();
        expect(await d.runtime.orchestrator.suspend(ws.id, suspended)).toEqual({ kind: "suspending" });
        await host().until("suspended", () => d.phase(suspended) === "suspended" && d.settled() && d.slot(suspended) === "none", 15_000);
        return { paneId: suspended };
      },
      (onDisk) => onDisk.includes('"reason":"suspended"'),
    );
    const mark = host().tape.length;
    const d = await open();
    await aWhile();
    expect(d.pane(paneId).idle?.reason).toBe("suspended");
    expect(d.launches(paneId)).toHaveLength(1);
    expect(callsOf(host(), "worktree_probe", mark)).toEqual([]);
    expect(await d.runtime.orchestrator.resume(d.workspace().id, paneId)).toEqual({ kind: "resuming" });
    await host().until("asked back, it rises", () => d.slot(paneId) === "live", 15_000);
  });
});
