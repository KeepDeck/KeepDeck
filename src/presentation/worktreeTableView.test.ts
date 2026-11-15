import { describe, expect, it } from "vitest";
import type { RepoCheckout, Team, Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { keptHeadName, worktreeRemovalConfirm, worktreeTableView } from "./worktreeTableView";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const attached = (id: string, name: string, cwd: string): Team => ({ id, name, location: { kind: "attached", cwd } });
const ws = (id: string, name: string, teams: Team[], over: Partial<Workspace> = {}): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name,
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  teams,
  ...over,
});
const row = (path: string, over: Partial<RepoCheckout> = {}): RepoCheckout => ({
  path,
  branch: `kd/${path.split("/").pop()}`,
  head: "2ce52ed0123456789",
  detached: false,
  locked: false,
  prunable: false,
  changed: 0,
  ...over,
});

const WEB = ws("ws-1", "Web", [attached("t1", "api", "/wt/api")]);
const SITE = ws("ws-2", "Site", [attached("t2", "docs", "/wt/docs")]);
const OLD = ws("ws-3", "Old", [attached("t3", "legacy", "/wt/legacy")], {
  archived: { at: "2026-11-01T00:00:00.000Z", phase: "archived" },
});
const DECK = [WEB, SITE, OLD];

describe("worktreeTableView", () => {
  it("names who holds each checkout — this workspace's team, another's, an archive's — and offers Remove only when nobody does", () => {
    const { rows } = worktreeTableView(
      [row("/repo", { branch: "main" }), row("/wt/api"), row("/wt/docs/"), row("/wt/legacy"), row("/wt/orphan", { changed: 3 })],
      WEB,
      DECK,
    );
    expect(rows.map((r) => [r.holder, r.removable])).toEqual([
      ["the workspace's own folder", false],
      ["team “api”", false],
      ["team “docs” in “Site”", false],
      ["team “legacy” in “Old” (archived)", false],
      ["no team", true],
    ]);
    expect(rows[4].state).toBe("3 changed entries");
  });

  it("says what is in a checkout: no changes, unknown, a folder that is gone, a lock", () => {
    const { rows } = worktreeTableView(
      [
        row("/a"),
        row("/b", { changed: null }),
        row("/c", { prunable: true, changed: null }),
        row("/d", { locked: true }),
        row("/e", { branch: null, detached: true }),
      ],
      WEB,
      DECK,
    );
    expect(rows.map((r) => r.state)).toEqual(["no changes", "changes unknown", "folder gone", "no changes · locked", "no changes"]);
    // A folder that is gone, or a locked one, is not offered for removal.
    expect(rows.map((r) => r.removable)).toEqual([true, true, false, false, true]);
    expect(rows[4].branch).toBe("detached at 2ce52ed");
  });
});

describe("worktreeRemovalConfirm", () => {
  it("asks to lose uncommitted work in so many words, and keeps the branch", () => {
    const confirm = worktreeRemovalConfirm(row("/wt/orphan", { changed: 2 }), WEB, NOW);
    expect(confirm.title).toBe("Remove the checkout at “orphan”?");
    expect(confirm.message).toContain("Its 2 changed entries are lost with the folder");
    expect(confirm.message).toContain("Its branch kd/orphan stays");
    expect(confirm).toMatchObject({ confirmLabel: "Remove and lose the changes", discardDirty: true });
    expect(confirm.keepHeadAs).toBeUndefined();
  });

  it("keeps a detached checkout's commit as a tag, named for the workspace and the folder", () => {
    const confirm = worktreeRemovalConfirm(row("/wt/deck preview", { branch: null, detached: true }), ws("w", "KeepDeck Web", []), NOW);
    expect(confirm.keepHeadAs).toBe("archive/KeepDeck-Web/deck-preview-2026-11-16");
    expect(confirm.message).toContain("its commit 2ce52ed is kept as the tag archive/KeepDeck-Web/deck-preview-2026-11-16");
    expect(confirm).toMatchObject({ confirmLabel: "Remove", discardDirty: false });
  });

  it("names a tag git takes, whatever the names hold", () => {
    expect(keptHeadName(ws("w", "Проект: 1/2", []), "/wt/a b..c.lock", NOW)).toBe("archive/1-2/a-b-c-lock-2026-11-16");
    expect(keptHeadName(ws("w", "Проект", []), "/wt/x", NOW)).toBe("archive/workspace/x-2026-11-16");
  });
});
