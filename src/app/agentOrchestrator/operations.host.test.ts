// @vitest-environment happy-dom
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";

/**
 * Each of an agent's operations end to end, on the app itself: the page's
 * doors, the lifecycle machine, the sessions machine, the bridge and a real
 * process in a PTY — the stub agent for a CLI. What the person sees is what
 * is held: where the agent is, whether it runs, which conversation it is in.
 */
describe("an agent's operations on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  const lastArgs = (d: Deck, paneId: string) => {
    const launches = d.launches(paneId);
    return launches[launches.length - 1]?.args ?? [];
  };
  const backUp = (d: Deck, paneId: string, launches: number) => () =>
    d.launches(paneId).length === launches && d.slot(paneId) === "live" && d.pane(paneId).session !== undefined;
  /** The pane's terminal mount generation: what a remount moves on. */
  const epoch = (d: Deck, paneId: string) => d.runtime.orchestrator.getView().epochs[paneId] ?? 0;

  it("suspends an agent, and resumes it into its own conversation", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
    // Over, as the page reads it before it offers Resume: the machine says
    // the pane is suspended. The deck's marker lands a moment before, while
    // the suspend still holds the pane — a resume then hears «busy».
    await host().until("suspended, its slot empty", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    expect(d.pane(paneId).idle?.reason).toBe("suspended");
    // Its terminal stays mounted: nothing replaces the process in place.
    expect(epoch(d, paneId)).toBe(0);
    await d.runtime.orchestrator.resume(ws.id, paneId);
    await host().until("it is back", backUp(d, paneId, 2));
    expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
    expect(d.pane(paneId).session?.id).toBe(session);
    expect(d.pane(paneId).idle).toBeUndefined();
  });

  it("suspends a team, and brings every member back", async () => {
    const d = await open();
    const { ws, paneId: lead } = await d.agentUp();
    const teamId = d.pane(lead).team?.teamId;
    if (!teamId) throw new Error("the lead is on no team");
    const member = await d.memberUp(teamId, "impl-1");
    await d.runtime.orchestrator.suspendTeam(ws.id, teamId, [lead, member]);
    await host().until("both are suspended", () => d.settled() && [lead, member].every((paneId) => d.phase(paneId) === "suspended" && d.slot(paneId) === "none"));
    await d.runtime.orchestrator.resumeTeam(ws.id, teamId);
    await host().until("both are back", () => backUp(d, lead, 2)() && backUp(d, member, 2)());
  });

  it("archives a workspace, restores it, and its agent comes back into its conversation when resumed", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    // The confirm's count, as the machine previews it: the one agent it stops.
    expect(await d.preview({ kind: "archive", workspace: ws.id })).toMatchObject({ refusal: null, stops: [paneId] });
    expect((await d.runtime.orchestrator.archive(ws)).kind).toBe("accepted");
    // Over, as the machine says it: the deck's marker settles a moment before
    // the archive's entry is off disk, while it still holds the workspace.
    await host().until("archived and over, its agent down", () => d.workspace().archived?.phase === "archived" && d.workspacePhase() === "archived" && d.slot(paneId) === "none");
    expect((await d.runtime.orchestrator.restore(ws)).kind).toBe("accepted");
    // Down as the page shows it and as the machine holds it: suspended both.
    await host().until("restored, the agent still down", () => d.workspace().archived === undefined && d.workspacePhase() === "live" && d.phase(paneId) === "suspended" && d.pane(paneId).idle?.reason === "suspended");
    expect(d.launches(paneId)).toHaveLength(1);
    expect(await d.runtime.orchestrator.resume(ws.id, paneId)).toMatchObject({ kind: "resuming" });
    await host().until("it is back", backUp(d, paneId, 2));
    expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
  });

  it("archives a workspace whose plantings would not come out: put away owing that, restored over it, and its agent resumed", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    // A record of the plantings that will not read: nothing can be taken
    // back from any folder while it stands.
    mkdirSync(join(host().home, "cwd-arms"), { recursive: true });
    writeFileSync(join(host().home, "cwd-arms", "ws-unreadable.json"), "not json");
    expect((await d.runtime.orchestrator.archive(ws)).kind).toBe("accepted");
    // Put away as the deck shows it — owing its plantings — and as the
    // machine says it: the page offers Restore on that word.
    await host().until(
      "put away, owing its plantings",
      () => d.workspace().archived?.phase === "archived" && d.workspace().archived?.warnings?.disarm === true && d.workspacePhase() === "archived" && d.slot(paneId) === "none",
      15_000,
    );
    // Its entry stays for the next launch, which tries the plantings again.
    expect(readdirSync(join(host().home, "lifecycle")).filter((name) => name.startsWith("op-"))).toHaveLength(1);

    // The owed archive does not keep the workspace away: Restore takes it over.
    expect((await d.runtime.orchestrator.restore(ws)).kind).toBe("accepted");
    await host().until("restored, its archive's entry gone", () =>
      d.workspace().archived === undefined && d.workspacePhase() === "live" && d.settled() &&
      readdirSync(join(host().home, "lifecycle")).every((name) => !name.startsWith("op-")));
    expect(await d.runtime.orchestrator.resume(ws.id, paneId)).toMatchObject({ kind: "resuming" });
    await host().until("it is back", backUp(d, paneId, 2));
  });

  it("restarts an agent fresh, into a new conversation", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    const before = epoch(d, paneId);
    expect((await d.runtime.orchestrator.restart(ws.id, paneId, "fresh")).kind).toBe("accepted");
    await host().until("a new process, a new conversation", () => backUp(d, paneId, 2)() && d.pane(paneId).session?.id !== session);
    expect(lastArgs(d, paneId)).not.toContain("--resume");
    // Remounted: the remount is what lets the pane's restart card go.
    expect(epoch(d, paneId)).toBeGreaterThan(before);
  });

  it("remounts a restarted agent when its old process is let go of, before the new one can start", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    // The next process's lease is not answered yet: nothing new starts.
    const leasing = host().hold({ request: "lifecycle_lease" });
    const before = epoch(d, paneId);
    expect((await d.runtime.orchestrator.restart(ws.id, paneId, "fresh")).kind).toBe("accepted");
    // The remount belongs to the letting go, not to the launch: the card is
    // freed with nothing started yet.
    await host().until("let go of and remounted", () => d.slot(paneId) === "none" && epoch(d, paneId) > before);
    expect(d.launches(paneId)).toHaveLength(1);
    leasing.release();
    await host().until("then the new one starts", backUp(d, paneId, 2));
  });

  it("restarts an agent into the conversation it was in", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    expect((await d.runtime.orchestrator.restart(ws.id, paneId, "resume")).kind).toBe("accepted");
    await host().until("a new process", backUp(d, paneId, 2));
    expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
    expect(d.pane(paneId).session?.id).toBe(session);
  });

  it("brings an agent back when it is restarted while its resume is still being prepared", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    await d.runtime.orchestrator.suspend(ws.id, paneId);
    await host().until("suspended", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    // The person resumes it, and its plan is slow to build…
    const building = host().hold({ request: "bridge_pane_dir" });
    await d.runtime.orchestrator.resume(ws.id, paneId);
    await building.caught;
    // …so they restart it, and the machine lets go of it for that.
    const before = epoch(d, paneId);
    expect((await d.runtime.orchestrator.restart(ws.id, paneId, "resume")).kind).toBe("accepted");
    await host().until("let go of for the restart", () => epoch(d, paneId) > before);
    // The resume's build ends after that: the restart is what the pane does now.
    building.release();
    await host().until("it is back, in its conversation", () => d.slot(paneId) === "live", 15_000);
    expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
  });

  it("closes an agent: its pane goes, its process with it, and nothing is held for it", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    const consent = await d.consentFor({ kind: "closeAgent", workspace: ws.id, pane: paneId, consent: { stops: [], folders: [], tickets: [] } });
    expect(consent.stops).toEqual([paneId]);
    expect((await d.runtime.orchestrator.close({ kind: "agent", workspace: ws, paneId, consent })).kind).toBe("accepted");
    await host().until("the pane is gone", () => !d.workspace().panes.some((pane) => pane.id === paneId) && d.slot(paneId) === "none");
  });

  it("disbands a team: its members go", async () => {
    const d = await open();
    const { ws, paneId: lead } = await d.agentUp();
    const teamId = d.pane(lead).team?.teamId;
    if (!teamId) throw new Error("the lead is on no team");
    const member = await d.memberUp(teamId, "impl-1");
    const consent = await d.consentFor({ kind: "disband", workspace: ws.id, team: teamId, consent: { stops: [], folders: [], tickets: [] } });
    expect((await d.runtime.orchestrator.close({ kind: "team", workspace: ws, teamId, consent })).kind).toBe("accepted");
    await host().until("the team and its members are gone", () => d.workspace().panes.length === 0 && [lead, member].every((paneId) => d.slot(paneId) === "none"));
    expect(d.workspace().teams ?? []).toEqual([]);
  });

  it("closes a workspace: it goes, its agents with it", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    const consent = await d.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } });
    expect((await d.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent })).kind).toBe("accepted");
    await host().until("the workspace is gone", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0 && d.slot(paneId) === "none");
    // All of it done on a default install — artifacts and tasks off: nothing
    // owed to a next launch.
    await host().until("its close is off the journal", () => readdirSync(join(host().home, "lifecycle")).every((name) => !name.startsWith("op-")));
  });

  it("forks an agent's conversation into a new agent of its team: a new conversation, copied from it", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    const teamId = d.pane(paneId).team?.teamId;
    if (!teamId) throw new Error("the lead is on no team");
    const forked = await d.runtime.orchestrator.forkSession(ws.id, { agent: "stub", sessionId: session, cwd: host().work }, { kind: "dir", cwd: host().work }, { role: "impl-1", team: teamId });
    if (forked.kind !== "accepted") throw new Error(`no fork: ${JSON.stringify(forked)}`);
    const fork = forked.minted.panes[0];
    if (!fork) throw new Error("the fork minted no pane");
    const conversation = await d.upAndBound(fork);
    expect(conversation).not.toBe(session);
    expect(lastArgs(d, fork)).toEqual(expect.arrayContaining(["--fork", session]));
    expect(d.pane(fork).team).toEqual({ teamId, role: "impl-1" });
    // The agent it was copied from runs on, in its own conversation.
    expect(d.slot(paneId)).toBe("live");
    expect(d.pane(paneId).session?.id).toBe(session);
    await host().until("the fork is over", () => d.settled());
  });

  it("restarts a fork's agent whose first launch is not up: the restart ends, and the fork is finished by the relaunch", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    const teamId = d.pane(paneId).team?.teamId;
    if (!teamId) throw new Error("the lead is on no team");
    // The fork's first process is not opened: its pane is never bound by it.
    const starting = host().hold({ request: "pty_open" });
    const forked = await d.runtime.orchestrator.forkSession(ws.id, { agent: "stub", sessionId: session, cwd: host().work }, { kind: "dir", cwd: host().work }, { role: "impl-1", team: teamId });
    if (forked.kind !== "accepted") throw new Error(`no fork: ${JSON.stringify(forked)}`);
    const fork = forked.minted.panes[0];
    if (!fork) throw new Error("the fork minted no pane");
    await starting.caught;
    expect((await d.runtime.orchestrator.restart(ws.id, fork, "fresh")).kind).toBe("accepted");
    starting.release();
    await d.upAndBound(fork);
    await host().until("nothing holds the pane: the restart and the fork are over", () => d.settled() && readdirSync(join(host().home, "lifecycle")).every((name) => !name.startsWith("op-")), 15_000);
    // Nothing refuses a close of it afterwards.
    const consent = await d.consentFor({ kind: "closeAgent", workspace: ws.id, pane: fork, consent: { stops: [], folders: [], tickets: [] } });
    expect((await d.runtime.orchestrator.close({ kind: "agent", workspace: ws, paneId: fork, consent })).kind).toBe("accepted");
  });

  it("asks nothing for a reference that outlived its workspace — a slot used again since", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    const stale = { id: ws.id, instance: createWorkspaceInstance() };
    const asked = host().tape.filter(({ line }) => line.includes('"cmd":"lifecycle_intent"')).length;
    const answers = await Promise.all([
      d.runtime.orchestrator.close({ kind: "workspace", workspace: stale, consent: { stops: [], folders: [], tickets: [] } }),
      d.runtime.orchestrator.close({ kind: "agent", workspace: stale, paneId, consent: { stops: [paneId], folders: [], tickets: [] } }),
      d.runtime.orchestrator.archive(stale),
      d.runtime.orchestrator.restore(stale),
    ]);
    for (const answer of answers) expect(answer).toEqual({ kind: "refused", refusal: { kind: "notFound" } });
    expect(host().tape.filter(({ line }) => line.includes('"cmd":"lifecycle_intent"'))).toHaveLength(asked);
    expect(d.workspace().panes.map((pane) => pane.id)).toEqual([paneId]);
    // The workspace's own reference still reaches it.
    expect(await d.runtime.orchestrator.archive(ws)).toMatchObject({ kind: "accepted" });
  });

  it("puts an agent back down and says why when the resume the person asked for cannot be built", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    await d.runtime.orchestrator.suspend(ws.id, paneId);
    await host().until("suspended", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    d.stub.resumePlanFails = "the agent's plugin is gone";
    await d.runtime.orchestrator.resume(ws.id, paneId);
    // A resume the person asked for never comes up as another conversation:
    // no process, the agent down where it was, its card saying why.
    await host().until("its card says why", () => (d.runtime.orchestrator.getView().wakeFailed[paneId] ?? "").includes("the agent's plugin is gone"));
    expect(d.launches(paneId)).toHaveLength(1);
    expect(d.pane(paneId).idle).toMatchObject({ reason: "suspended" });
    expect(d.pane(paneId).session?.id).toBe(session);
  });

  it("asks a launch lease that failed again only once the machine's state moves — never in a loop", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    await d.runtime.orchestrator.suspend(ws.id, paneId);
    await host().until("suspended", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    const leases = () => host().tape.filter(({ line }) => line.includes('"cmd":"lifecycle_lease"')).length;
    const before = leases();
    const restore = host().fail("lifecycle_lease");
    await d.runtime.orchestrator.resume(ws.id, paneId);
    await host().until("the resume is over", () => d.phase(paneId) === "live" && d.settled());
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Asked again once per state of the machine, not as fast as it fails.
    expect(leases() - before).toBeLessThan(10);
    restore();
    // The next move of the machine's state asks again, and it comes up.
    await d.runtime.orchestrator.restart(ws.id, paneId, "resume");
    await host().until("it is back", () => d.slot(paneId) === "live");
  });

  it("leaves an agent that ended by itself on its exit card, starting nothing", async () => {
    const d = await open();
    const { paneId } = await d.agentUp();
    d.type(paneId, "exit 3");
    await host().until("its process ended", () => d.slot(paneId) === "exited");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(d.launches(paneId)).toHaveLength(1);
    expect(d.slot(paneId)).toBe("exited");
  });

  it("suspends an agent while its process is starting, and it comes back when resumed", async () => {
    const d = await open();
    const ws = await d.workspaceUp();
    const starting = host().hold({ request: "pty_open" });
    const paneId = await d.addAgent({ role: "lead" });
    await starting.caught;
    expect(await d.runtime.orchestrator.suspend(ws.id, paneId)).toEqual({ kind: "suspending" });
    starting.release();
    await host().until("suspended, its slot empty", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    await d.runtime.orchestrator.resume(ws.id, paneId);
    await host().until("it is up", () => d.slot(paneId) === "live" && d.pane(paneId).session !== undefined);
  });

  it("restarts an agent that ignores the polite stop: the new process starts once the old one is killed", async () => {
    const d = await open();
    d.stub.deaf = true;
    const { ws, paneId, session } = await d.agentUp();
    d.stub.deaf = false;
    expect((await d.runtime.orchestrator.restart(ws.id, paneId, "resume")).kind).toBe("accepted");
    await host().until("a new process", backUp(d, paneId, 2), 15_000);
    expect(lastArgs(d, paneId)).toEqual(expect.arrayContaining(["--resume", session]));
  });

  it("stops an agent that ignores the polite stop by the kill, and it comes back when resumed", async () => {
    const d = await open();
    d.stub.deaf = true;
    const { ws, paneId } = await d.agentUp();
    await d.runtime.orchestrator.suspend(ws.id, paneId);
    await host().until("killed, and suspended", () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none", 15_000);
    await d.runtime.orchestrator.resume(ws.id, paneId);
    await host().until("it is back", backUp(d, paneId, 2));
  });
});
