// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    await host().until("the team, its folder and its branch are gone", () => d.workspace().panes.length === 0 && !existsSync(cwd) && git(host().work, "branch", "--list", branch) === "", 15_000);
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
    await host().until("the workspace is gone, and no worktree or branch of its team is left", () => d.runtime.deckStore.getSnapshot().workspaces.length === 0 && onlyTheRepo(), 15_000);
  });
});
