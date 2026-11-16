// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoCheckout, UnheldRemoval, UnheldRemovalRequest, Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { WorktreesSection, type WorktreesSectionProps } from "./WorktreesSection";
import { present } from "@keepdeck/plugin-api/testing";

const WEB: Workspace = {
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  teams: [{ id: "t1", name: "api", location: { kind: "attached", cwd: "/wt/api" } }],
};
const ROWS: RepoCheckout[] = [
  { path: "/repo", branch: "main", head: "a1", detached: false, locked: false, prunable: false, changed: 0 },
  { path: "/wt/api", branch: "kd/api", head: "b2", detached: false, locked: false, prunable: false, changed: 0 },
  { path: "/wt/orphan", branch: "kd/orphan", head: "c3", detached: false, locked: false, prunable: false, changed: 2 },
];

describe("WorktreesSection", () => {
  let root: Root;
  const listWorktrees = vi.fn<(repo: string) => Promise<RepoCheckout[]>>();
  const onRemove = vi.fn<(request: UnheldRemovalRequest) => Promise<UnheldRemoval>>();
  const onNewTeam = vi.fn();
  const onOpenTeam = vi.fn();
  const render = async (over: Partial<WorktreesSectionProps> = {}) =>
    act(async () =>
      root.render(
        createElement(WorktreesSection, {
          workspace: WEB,
          workspaces: [WEB],
          listWorktrees,
          onRemove,
          onNewTeam,
          onOpenTeam,
          ...over,
        }),
      ),
    );
  const cells = () =>
    Array.from(document.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
  const button = (text: string) =>
    present(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text),
      `the "${text}" button`,
    );

  beforeEach(() => {
    listWorktrees.mockReset().mockResolvedValue(ROWS);
    onRemove.mockReset().mockResolvedValue({ kind: "removed" });
    onNewTeam.mockReset();
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => act(() => root.unmount()));

  it("lists the repository's checkouts under named columns, who holds each, and what can be done with it", async () => {
    await render();
    expect(listWorktrees).toHaveBeenCalledWith("/repo");
    expect(Array.from(document.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "Folder",
      "Branch",
      "Held by",
      "State",
      "",
    ]);
    expect(cells()).toEqual([
      ["repo", "main", "workspace folder", "clean", ""],
      ["/wt/api", "kd/api", "api", "clean", "Open team"],
      ["/wt/orphan", "kd/orphan", "no team", "2 uncommitted", "Remove"],
    ]);
    // The full path where the column shortens it; the row nobody holds stands out.
    expect(document.querySelector(".worktrees__folder")?.getAttribute("title")).toBe("/repo");
    expect(document.querySelectorAll(".worktrees__row--free")).toHaveLength(1);
    expect(document.body.textContent).toContain("A worktree no team uses can be removed here. Its branch is kept.");
  });

  it("draws no acts column when no row has anything to do — the table keeps its width", async () => {
    listWorktrees.mockResolvedValue(ROWS.slice(0, 1));
    await render();
    expect(document.querySelectorAll("th")).toHaveLength(4);
    expect(cells()).toEqual([["repo", "main", "workspace folder", "clean"]]);
    // Nothing to remove: nothing said about removing.
    expect(document.body.textContent).not.toContain("can be removed");
  });

  it("opens the team a checkout belongs to", async () => {
    await render();
    act(() => button("Open team").click());
    expect(onOpenTeam).toHaveBeenCalledWith("ws-1", "t1");
  });

  it("removes one behind a confirm that names the lost changes, says what happened, and reads the list again", async () => {
    await render();
    act(() => button("Remove").click());
    expect(document.body.textContent).toContain("Its 2 changed entries are lost with the folder");
    listWorktrees.mockResolvedValue(ROWS.slice(0, 2));
    await act(async () => button("Remove and lose the changes").click());
    expect(onRemove).toHaveBeenCalledWith({ repo: "/repo", path: "/wt/orphan", discardDirty: true });
    expect(document.querySelector("[role='status']")?.textContent).toBe("Removed.");
    expect(listWorktrees).toHaveBeenCalledTimes(2);
    expect(cells()).toHaveLength(2);
  });

  it("cancels without removing anything", async () => {
    await render();
    act(() => button("Remove").click());
    act(() => button("Cancel").click());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("opens a new team in a worktree, and offers none for an archive", async () => {
    await render();
    act(() => button("New team in a worktree").click());
    expect(onNewTeam).toHaveBeenCalledOnce();
    await render({ onNewTeam: null });
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "New team in a worktree")).toBe(false);
  });

  it("says when the folder is not a repository", async () => {
    listWorktrees.mockRejectedValue(new Error("not a git repository"));
    await render();
    expect(document.body.textContent).toContain("Not a git repository");
  });
});
