// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { cleanStatus, makeCtx, makeGit, mountGitHarness } from "./gitHarness";

/**
 * History mode's LISTING: the log, the fork divider and its since-fork
 * summary, lazy paging, and browsing a ref that is not checked out. What
 * opening one of these rows shows lives in `GitPeek.test.tsx`.
 */
const rig = mountGitHarness();

async function openHistory() {
  const historyBtn = [
    ...rig.host.querySelectorAll("button.git__modebtn"),
  ].find((el) => el.textContent === "History") as HTMLButtonElement;
  await act(async () => historyBtn.click());
}

describe("History listing", () => {
  it("lists commits since the fork, split from base history by the divider", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    const fork = "f0".repeat(20);
    git.histories.set("/repo", {
      forkSha: fork,
      ahead: 2,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "add feature" },
        { sha: "b2".repeat(20), author: "Agent", timestamp: 1_750_000_000, subject: "fix tests" },
        // The FULL log continues past the fork commit into base history.
        { sha: fork, author: "Me", timestamp: 1_740_000_000, subject: "base work" },
        { sha: "e5".repeat(20), author: "Me", timestamp: 1_730_000_000, subject: "older base work" },
      ],
    });
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    // Commits newest-first plus the pinned since-fork summary; the count is
    // the branch's own side of the fork, not the listing length.
    expect(rig.host.textContent).toContain("Since fork");
    expect(rig.host.textContent).toContain("2 commits");
    expect(rig.host.textContent).toContain("add feature");
    expect(rig.host.textContent).toContain("fix tests");
    expect(rig.host.textContent).toContain("a1a1a1a");
    // The full history is visible too, split by the fork-point divider:
    // branch work above, base history below.
    expect(rig.host.textContent).toContain("base work");
    expect(rig.host.textContent).toContain("older base work");
    expect(rig.host.querySelector(".git__forkline")).toBeTruthy();
    // The list is a single pane now — no slide track, no drill back button.
    expect(rig.host.querySelector(".git__track")).toBeNull();
    expect(rig.host.querySelector(".git__drillback")).toBeNull();
  });

  it("without a fork point History is a plain log with no since-fork row", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: [
        { sha: "d4".repeat(20), author: "Me", timestamp: 1_760_000_000, subject: "init" },
      ],
    });
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    expect(rig.host.textContent).toContain("init");
    expect(rig.host.textContent).not.toContain("Since fork");
    expect(rig.host.querySelector(".git__forkline")).toBeNull();
  });

  it("loads lazily in chunks of 50 and stops when the log runs dry", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: Array.from({ length: 60 }, (_, i) => ({
        sha: String(i).padStart(2, "0").repeat(20),
        author: "Me",
        timestamp: 1_760_000_000 - i,
        subject: `commit ${i}`,
      })),
    });
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    // First chunk: 50 commit rows and a live sentinel.
    expect(git.history).toHaveBeenCalledWith("/repo", { limit: 50 });
    expect(rig.host.querySelectorAll("button.git__row").length).toBe(50);
    const more = rig.host.querySelector(
      "button.git__more",
    ) as HTMLButtonElement;
    expect(more).toBeTruthy();

    // The next chunk widens the window; a 60-commit repo underfills it, so
    // the sentinel retires — the list is complete.
    await act(async () => more.click());
    expect(git.history).toHaveBeenCalledWith("/repo", { limit: 100 });
    expect(rig.host.querySelectorAll("button.git__row").length).toBe(60);
    expect(rig.host.querySelector("button.git__more")).toBeNull();
  });

  it("can browse a branch that is not checked out", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.branchLists.set("/repo", {
      current: "main",
      branches: ["kd/side/1", "main"],
    });
    const fork = "f0".repeat(20);
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: [
        { sha: "d4".repeat(20), author: "Me", timestamp: 1_760_000_000, subject: "init" },
      ],
    });
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    // The picker marks the checkout with the green-check badge, not a text
    // suffix; switching to the foreign branch walks it by ref — no checkout
    // involved.
    expect(rig.host.querySelector(".git__refcur .git__refcheck")).toBeTruthy();
    expect(rig.host.textContent).not.toContain("checked out");
    git.histories.set("/repo", {
      forkSha: fork,
      ahead: 1,
      commits: [
        { sha: "a9".repeat(20), author: "Agent", timestamp: 1_760_000_100, subject: "side work" },
        { sha: fork, author: "Me", timestamp: 1_760_000_000, subject: "init" },
      ],
    });
    // The ui-kit Dropdown portals its listbox outside this component host.
    const trigger = rig.host.querySelector(
      ".git__ref .dropdown__button",
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll("button[role='option']")].find(
      (el) => el.textContent === "kd/side/1",
    ) as HTMLButtonElement;
    await act(async () => option.click());

    expect(git.history).toHaveBeenLastCalledWith("/repo", {
      limit: 50,
      rev: "kd/side/1",
    });
    expect(rig.host.textContent).toContain("side work");

    // Since-fork on a foreign ref pins the range's end to the ref — there is
    // no working tree to reach.
    const pin = rig.host.querySelector(
      "button.git__row--pin",
    ) as HTMLButtonElement;
    await act(async () => pin.click());
    expect(git.changedFiles).toHaveBeenCalledWith("/repo", fork, "kd/side/1");
  });
});
