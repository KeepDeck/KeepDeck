// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { setRuntime } from "../runtime";
import { takePeekRequest } from "../peekRequests";
import {
  cleanStatus,
  makeCtx,
  makeGit,
  mountGitHarness,
  workspace,
} from "./gitHarness";

/**
 * The Git TAB: its change list, the repo it roots on, and the live feed
 * behind both. What a row OPENS is the peek's business and lives in
 * `GitPeek.test.tsx`; the History listing lives in `GitHistory.test.tsx`.
 * The one test here that touches opening is the guard that the tab renders no
 * peek of its own.
 */
const rig = mountGitHarness();

describe("GitTab", () => {
  it("shows the branch line and grouped changes for the workspace repo", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      entries: [
        { path: "src/app.ts", origPath: null, staged: ".", unstaged: "M", untracked: false, conflicted: false },
        { path: "notes.md", origPath: null, staged: ".", unstaged: ".", untracked: true, conflicted: false },
      ],
    }));
    setRuntime(makeCtx(git));

    await rig.render();

    expect(rig.host.textContent).toContain("main");
    expect(rig.host.textContent).toContain("↑2 ↓1");
    expect(rig.host.textContent).toContain("Changes");
    expect(rig.host.textContent).toContain("app.ts");
    expect(rig.host.textContent).toContain("Untracked");
    expect(rig.host.textContent).toContain("notes.md");
    // Sections with no rows don't render at all.
    expect(rig.host.textContent).not.toContain("Staged");
    expect(rig.host.textContent).not.toContain("Conflicts");
  });

  it("defaults to the highlighted pane's worktree and says so when it is clean", async () => {
    const git = makeGit();
    git.statuses.set("/wt/one", cleanStatus({ branch: "kd/app/1" }));
    setRuntime(makeCtx(git));

    await rig.render("p1");

    expect(git.status).toHaveBeenCalledWith("/wt/one");
    expect(rig.host.textContent).toContain("kd/app/1");
    expect(rig.host.textContent).toContain("No changes");
  });

  it("watch events re-read the status after the debounce — no refresh button exists", async () => {
    vi.useFakeTimers();
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    setRuntime(makeCtx(git));

    await rig.render();
    await rig.settle(0);
    expect(rig.host.textContent).toContain("No changes");
    expect(rig.host.querySelector("button[title*='efresh']")).toBeNull();

    // The repo becomes dirty; a burst of watch events lands.
    git.statuses.set("/repo", cleanStatus({
      entries: [
        { path: "hot.ts", origPath: null, staged: ".", unstaged: "M", untracked: false, conflicted: false },
      ],
    }));
    const before = git.status.mock.calls.length;
    git.fireChange("/repo");
    git.fireChange("/repo");
    git.fireChange("/repo");

    await rig.settle(299);
    // Still within the debounce window — no read yet.
    expect(git.status.mock.calls.length).toBe(before);

    await rig.settle(2);
    expect(git.status.mock.calls.length).toBe(before + 1);
    expect(rig.host.textContent).toContain("hot.ts");
  });

  it("renders no peek of its own — it hands the diff to the resident overlay", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus({
      entries: [
        { path: "src/app.ts", origPath: null, staged: ".", unstaged: "M", untracked: false, conflicted: false },
      ],
    }));
    setRuntime(makeCtx(git));

    await rig.renderTabOnly();
    const row = [...rig.host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("app.ts"),
    );
    await act(async () => {
      (row as HTMLButtonElement).click();
    });

    // Nothing full-window inside the tab: a peek rendered here would be
    // hidden with the tab body and destroyed when the dock closes.
    expect(rig.host.querySelector(".peek")).toBeNull();
    expect(git.diffFile).not.toHaveBeenCalled();
    // The open gesture went out as a request instead, carrying the repo it
    // was opened on.
    expect(takePeekRequest()).toEqual({
      repo: "/repo",
      // The workspace rides along: the peek must not outlive it.
      workspace: { id: workspace.id, instance: workspace.instance },
      kind: "worktree",
      row: expect.objectContaining({ path: "src/app.ts" }),
    });
  });

  it("tears down the repo watcher when the root switches", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.statuses.set("/wt/one", cleanStatus({ branch: "kd/app/1" }));
    setRuntime(makeCtx(git));

    await rig.render();
    expect(git.watcherCount("/repo")).toBe(1);

    // Highlighting the pane re-roots the tab onto its worktree.
    await rig.render("p1");
    expect(git.watcherCount("/repo")).toBe(0);
    expect(git.watcherCount("/wt/one")).toBe(1);
  });

  it("surfaces a status failure instead of a stuck spinner", async () => {
    const git = makeGit(); // no statuses registered → status() rejects
    setRuntime(makeCtx(git));

    await rig.render();

    expect(rig.host.textContent).toContain("not a git repository");
  });
});
