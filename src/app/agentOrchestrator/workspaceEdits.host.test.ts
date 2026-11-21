// @vitest-environment happy-dom
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRef } from "../../domain/workspaceInstance";
import { useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";

/**
 * A workspace edited while the app runs — its name, its folder, its worktree
 * base — end to end on the app itself: the machine places, names and roots
 * what comes after by the edit, not by the workspace as it was made.
 */
describe("a workspace's edits, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  const edit = (d: Deck, ws: WorkspaceRef, patch: Parameters<Deck["runtime"]["orchestrator"]["updateWorkspace"]>[1]) => {
    const result = d.runtime.orchestrator.updateWorkspace(ws, patch);
    if (!result.ok) throw new Error(`the edit was refused: ${JSON.stringify(result.refusal)}`);
  };
  /** A team asked for in a new worktree the machine places itself; where
   * it went, and on which branch. */
  const newWorktree = async (d: Deck, ws: WorkspaceRef) => {
    const paneId = await d.addAgent({ role: "lead", workspace: ws, site: { kind: "new", place: null, base: null } });
    await d.upAndBound(paneId);
    const teamId = d.pane(paneId).team?.teamId;
    const team = d.runtime.deckStore.getSnapshot().workspaces.flatMap((candidate) => candidate.teams ?? []).find((candidate) => candidate.id === teamId);
    if (team?.location?.kind !== "attached") throw new Error(`no worktree for ${paneId}: ${JSON.stringify(team)}`);
    return { paneId, cwd: team.location.cwd, branch: team.location.branch ?? "" };
  };

  it("places a new team's worktree under a base folder given after the workspace was made", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.anotherWorkspace("ws", host().work);
    edit(d, ws, { worktreeBaseDir: host().trees });
    const { cwd } = await newWorktree(d, ws);
    expect(cwd.startsWith(`${host().trees}/`)).toBe(true);
  });

  it("puts new worktrees under the base folder it was changed to", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    const elsewhere = join(host().trees, "elsewhere");
    mkdirSync(elsewhere);
    edit(d, ws, { worktreeBaseDir: elsewhere });
    const { cwd } = await newWorktree(d, ws);
    expect(cwd.startsWith(`${elsewhere}/`)).toBe(true);
  });

  it("names a new worktree and its branch by the name the workspace was renamed to", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    edit(d, ws, { name: "renamed" });
    const { cwd, branch } = await newWorktree(d, ws);
    expect(cwd).toContain("renamed");
    expect(branch).toContain("renamed");
  });

  it("starts the agents of a workspace moved to another folder, while it held nothing, in that folder", async () => {
    const d = await open();
    const ws = await d.workspaceUp();
    const moved = join(host().work, "moved");
    mkdirSync(moved);
    edit(d, ws, { cwd: moved });
    const paneId = await d.addAgent({ role: "lead", workspace: ws });
    await d.upAndBound(paneId);
    expect(d.launches(paneId)[0]?.cwd).toBe(moved);
  });
});
