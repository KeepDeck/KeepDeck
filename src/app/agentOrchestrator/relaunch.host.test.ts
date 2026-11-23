// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useHost, type Ending } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";

/**
 * The app ended and launched again on the same home, end to end: quit as
 * the person quits it, or crashed in the middle of an operation. What the
 * next launch finds — the deck it saved, the machine's journal, the folders
 * on disk — is all it has, and the person sees it whole.
 */
describe("the app launched again on the same home", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  /** End the app and its page as `how` says, and open both again. */
  const again = async (how: Ending) => {
    deck?.dispose();
    deck = null;
    await host().relaunch(how);
    return open();
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const worktrees = () =>
    git(host().work, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  const lastLaunch = (d: Deck, paneId: string) => {
    const launches = d.launches(paneId);
    return launches[launches.length - 1];
  };

  for (const how of ["quit", "crash"] as const) {
    it(`after a ${how}, the agent rises again into its own conversation`, async () => {
      const first = await open();
      const { paneId, session } = await first.agentUp();
      // A crash takes what was not yet saved with it: the conversation is
      // the deck's once the deck on disk names it.
      await host().until("its conversation is on disk", () => readFileSync(join(host().home, "deck.json"), "utf8").includes(session));
      const d = await again(how);
      await host().until("it rose again", () => d.launches(paneId).length === 2 && d.slot(paneId) === "live" && d.pane(paneId).session?.id === session, 15_000);
      expect(lastLaunch(d, paneId)?.args).toEqual(expect.arrayContaining(["--resume", session]));
    });
  }

  it("crashed once a team's worktree was made but before the team landed in it: the next launch lands it there", async () => {
    const first = await open();
    first.gitRepo();
    await first.workspaceUp();
    const settling = host().hold({ heard: '"kind":"settleTeam"' });
    const paneId = await first.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } });
    await settling.caught;
    const made = worktrees()[1];
    if (!made) throw new Error("no worktree was made");

    const d = await again("crash");
    await host().until("the team landed in its worktree, its agent up there", () => d.slot(paneId) === "live" && lastLaunch(d, paneId)?.cwd === made, 15_000);
    expect(worktrees()).toEqual([host().work, made]);
  });

  it("crashed in the middle of a workspace's close: the next launch finishes it, its worktree and branch deleted", async () => {
    const first = await open();
    first.gitRepo();
    const ws = await first.workspaceUp();
    const paneId = await first.addAgent({ role: "lead", site: { kind: "new", place: null, base: null } });
    await first.upAndBound(paneId);
    const made = worktrees()[1];
    if (!made) throw new Error("no worktree was made");
    const branch = git(made, "rev-parse", "--abbrev-ref", "HEAD");

    // The close is taken and on disk; the page has not yet heard its
    // workspace go.
    const removing = host().hold({ heard: '"kind":"removeWorkspace"' });
    const consent = await first.consentFor({ kind: "closeWorkspace", workspace: ws.id, consent: { stops: [], folders: [], tickets: [] } }, true);
    expect((await first.runtime.orchestrator.close({ kind: "workspace", workspace: ws, consent })).kind).toBe("accepted");
    await removing.caught;

    const d = await again("crash");
    await host().until("the workspace, its worktree and its branch are gone, and the close is over", () =>
      d.runtime.deckStore.getSnapshot().workspaces.length === 0 && !existsSync(made) && git(host().work, "branch", "--list", branch) === "" && host().journalEmpty(), 15_000);
    expect(d.launches(paneId)).toHaveLength(1);
  });
});
