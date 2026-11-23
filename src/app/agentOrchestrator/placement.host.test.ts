// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimsOn } from "../../ipc/lifecycle";
import { useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";

/**
 * Where a team runs, end to end on the app itself: the workspace's root, a
 * folder that already exists, or a worktree the machine makes with git —
 * and what a close that deletes it takes with it.
 */
describe("where a team runs, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  const firstCwd = (d: Deck, paneId: string) => d.launches(paneId)[0]?.cwd ?? null;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("runs a team in the workspace's root", async () => {
    const d = await open();
    const { paneId } = await d.agentUp();
    expect(firstCwd(d, paneId)).toBe(host().work);
  });

  it("runs a team in a folder that already exists", async () => {
    const d = await open();
    const folder = join(host().work, "service");
    mkdirSync(folder);
    const paneId = await d.addAgent({ role: "lead", site: { kind: "existing", cwd: folder } });
    await d.upAndBound(paneId);
    expect(firstCwd(d, paneId)).toBe(folder);
  });

  it("makes a team a worktree of its own, and a disband that deletes it takes the folder and the branch", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    const paneId = await d.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } });
    await d.upAndBound(paneId);
    const cwd = firstCwd(d, paneId);
    if (!cwd) throw new Error("the agent started in no folder");
    expect(cwd).not.toBe(host().work);
    const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    expect(git(host().work, "worktree", "list")).toContain(cwd);

    const teamId = d.pane(paneId).team?.teamId;
    if (!teamId) throw new Error("the lead is on no team");
    const consent = await d.consentFor({ kind: "disband", workspace: ws.id, team: teamId, consent: { stops: [], folders: [], tickets: [] } }, true);
    expect(consent.folders.map((folder) => folder.path)).toEqual([cwd]);
    expect((await d.runtime.orchestrator.close({ kind: "team", workspace: ws, teamId, consent })).kind).toBe("accepted");
    await host().until("the team, its folder and its branch are gone, and the disband is over", () => d.workspace().panes.length === 0 && !existsSync(cwd) && git(host().work, "branch", "--list", branch) === "" && host().journalEmpty(), 15_000);
  });

  it("forks a conversation into a worktree of its own: the team is made there, and the fork runs in it", async () => {
    const d = await open();
    d.gitRepo();
    const { ws, session } = await d.agentUp();
    const path = join(host().trees, "fork-1");
    const forked = await d.runtime.orchestrator.forkSession(ws.id, { agent: "stub", sessionId: session, cwd: host().work }, { kind: "worktree", path, branch: "kd/ws/fork-1" }, { role: "lead" });
    if (forked.kind !== "accepted") throw new Error(`no fork: ${JSON.stringify(forked)}`);
    const fork = forked.minted.panes[0];
    if (!fork) throw new Error("the fork minted no pane");
    expect(await d.upAndBound(fork)).not.toBe(session);
    expect(firstCwd(d, fork)).toBe(path);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("kd/ws/fork-1");
  });

  /** A fork of the agent's conversation into a worktree of its own, asked. */
  const forkIntoWorktree = (d: Deck, ws: { id: string }, session: string, path: string) =>
    d.runtime.orchestrator
      .forkSession(ws.id, { agent: "stub", sessionId: session, cwd: host().work }, { kind: "worktree", path, branch: "kd/ws/fork-1" }, { role: "lead" })
      .catch((error: unknown) => error);

  for (const ticked of [true, false]) {
    it(`closes a workspace while a fork is making its team: the fork's worktree ${ticked ? "goes, with its branch, as the person ticked" : "stays, unticked"}, nothing left owed`, async () => {
      const d = await open();
      d.gitRepo();
      const { ws, paneId, session } = await d.agentUp();
      // The fork's team is made; its launch plan is asked of the page.
      const planning = host().hold({ heard: '"kind":"fork"' });
      const path = join(host().trees, "fork-1");
      const asked = forkIntoWorktree(d, ws, session, path);
      await planning.caught;
      const consent = await d.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } }, ticked);
      expect(consent.stops).toHaveLength(2);
      const closing = d.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent });
      planning.release();
      expect((await closing).kind).toBe("accepted");
      await asked;
      await host().until("the workspace is gone, no agent left", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0 && d.slot(paneId) === "none", 15_000);
      await host().until("nothing of the close or the fork is owed", () => host().journalEmpty(), 15_000);
      expect(existsSync(path)).toBe(!ticked);
      expect(git(host().work, "branch", "--list", "kd/ws/fork-1") === "").toBe(ticked);
    });
  }

  it("closes a fork's agent before its launch is up: the fork is taken back, its worktree kept, nothing left owed", async () => {
    const d = await open();
    d.gitRepo();
    const { ws, session } = await d.agentUp();
    // The fork's process is not opened yet: it is never bound.
    const starting = host().hold({ request: "pty_open" });
    const path = join(host().trees, "fork-1");
    const asked = d.runtime.orchestrator.forkSession(ws.id, { agent: "stub", sessionId: session, cwd: host().work }, { kind: "worktree", path, branch: "kd/ws/fork-1" }, { role: "lead" });
    await starting.caught;
    const forked = await asked;
    if (forked.kind !== "accepted") throw new Error(`no fork: ${JSON.stringify(forked)}`);
    const fork = forked.minted.panes[0];
    if (!fork) throw new Error("the fork minted no pane");
    const consent = await d.consentFor({ kind: "closeAgent", workspace: ws.id, pane: fork, consent: { stops: [], folders: [], tickets: [] } });
    expect((await d.runtime.orchestrator.close({ kind: "agent", workspace: ws, paneId: fork, consent })).kind).toBe("accepted");
    starting.release();
    await host().until("the fork's agent and its team are gone", () => !d.workspace().panes.some((pane) => pane.id === fork) && (d.workspace().teams ?? []).length === 1, 15_000);
    await host().until("nothing of the close or the fork is owed", () => host().journalEmpty(), 15_000);
    // An agent's close deletes no folder: the worktree made for the fork stays.
    expect(existsSync(path)).toBe(true);
  });

  it("takes back a fork whose agent never takes up the conversation: its worktree, its branch and all the page held of its pane go", async () => {
    const d = await open();
    d.gitRepo();
    const { ws, session } = await d.agentUp();
    d.stub.rejectForks = true;
    const path = join(host().trees, "fork-1");
    const forked = await forkIntoWorktree(d, ws, session, path);
    expect(forked).toMatchObject({ kind: "accepted" });
    await host().until("the fork is taken back whole", () => d.workspace().panes.length === 1 && (d.workspace().teams ?? []).length === 1 && host().journalEmpty(), 15_000);
    expect(existsSync(path)).toBe(false);
    expect(git(host().work, "branch", "--list", "kd/ws/fork-1")).toBe("");
    // Its pane is retired with it, as every pane that leaves is: the plan
    // its hook built, and what its process said, are gone too.
    const fork = d.stub.plans.find((plan) => plan.hook === "fork")?.input.paneId;
    if (!fork) throw new Error("no fork was planned");
    expect(d.holdsPlan(fork)).toBe(false);
    expect(d.runtime.statusTracker.getSnapshot().panes.has(fork)).toBe(false);
  });

  it("refuses to remove a folder no team holds while its workspace is being closed", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    const orphan = join(host().trees, "orphan");
    git(host().work, "worktree", "add", "-q", "-b", "orphan", orphan);
    // The close is under way: the page has not yet heard its workspace go.
    const removing = host().hold({ heard: '"kind":"removeWorkspace"' });
    const consent = await d.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } });
    expect((await d.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent })).kind).toBe("accepted");
    await removing.caught;
    expect(await d.runtime.orchestrator.removeUnheld(ws, { path: orphan, discardDirty: false })).toMatchObject({ kind: "refused", refusal: { kind: "targetLeaving" } });
    removing.release();
    await host().until("the workspace is gone", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0, 15_000);
    // Nothing outlived the workspace to take the folder after it.
    expect(existsSync(orphan)).toBe(true);
  });

  it("keeps a folder no team holds that became dirty since its removal was confirmed clean, and says so — and removes it with leave to lose the work", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    const orphan = join(host().trees, "orphan");
    git(host().work, "worktree", "add", "-q", "-b", "orphan", orphan);
    // Confirmed as clean; an editor writes into it before the removal runs.
    const work = join(orphan, "draft.txt");
    writeFileSync(work, "unsaved elsewhere");
    expect(await d.runtime.orchestrator.removeUnheld(ws, { path: orphan, discardDirty: false })).toMatchObject({ kind: "accepted" });
    await host().until("its removal is said to have failed", () =>
      host().tape.some(({ way, line }) => way === "← host" && line.includes('"kind":"worktreeNotDeleted"') && line.includes(orphan)), 15_000);
    // It ends there: the machine holds the folder against no next ask — its
    // own word, the one the worktrees table reads before it offers Remove —
    // and owes nothing on disk.
    await host().until("nobody holds the folder", async () => (await claimsOn(orphan)).length === 0, 15_000);
    expect(host().journalEmpty()).toBe(true);
    expect(existsSync(work)).toBe(true);
    // With the person's leave to lose it, it goes.
    expect((await d.runtime.orchestrator.removeUnheld(ws, { path: orphan, discardDirty: true })).kind).toBe("accepted");
    await host().until("it is gone, and its removal is over", () => !existsSync(orphan) && host().journalEmpty(), 15_000);
  });

  const onlyTheRepo = () =>
    git(host().work, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length === 1 &&
    git(host().work, "branch", "--list", "kd/*") === "";

  it("closes a workspace whose team's place is only recorded: nothing was made, and nothing is left", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    // The page has not yet said the team's row landed: no worktree is made
    // before the deck holds its place.
    const landing = host().hold({ request: "lifecycle_applied" });
    const asked = d.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } }).catch((error: unknown) => error);
    await landing.caught;
    const consent = await d.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } }, true);
    expect(consent).toEqual({ stops: [], folders: [], tickets: [] });
    // Let the row land only once the close is taken: landing first, it puts
    // an agent in the workspace the dialog never showed — asked again.
    expect((await d.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent })).kind).toBe("accepted");
    landing.release();
    await asked;
    await host().until("the workspace is gone, its team never made", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0 && onlyTheRepo(), 15_000);
  });

  it("closes a workspace while its team's worktree stands but has not landed: the worktree and its branch go with it", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    // The worktree is made; the page has not heard the team settle into it.
    const settling = host().hold({ heard: '"kind":"settleTeam"' });
    const asked = d.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } }).catch((error: unknown) => error);
    await settling.caught;
    const made = git(host().work, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
    expect(made).toHaveLength(2);
    // The machine made it, so it knows the folder: offered as one, not as a
    // creation still out.
    const consent = await d.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } }, true);
    expect(consent.folders.map((folder) => folder.path)).toEqual([made[1]]);
    expect(consent.tickets).toEqual([]);
    expect((await d.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent })).kind).toBe("accepted");
    settling.release();
    await asked;
    await host().until("the workspace is gone, no worktree or branch of its team is left, and the close is over", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0 && onlyTheRepo() && host().journalEmpty(), 15_000);
  });
});
