// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { GitChangedFile } from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { cleanStatus, makeCtx, makeGit, mountGitHarness } from "./gitHarness";

/**
 * The whole gesture: a row or a history scope in the tab, through the request
 * bus, into the resident overlay's peek — its body, its file rail and the
 * arrow navigation across it. Mounting both halves is the point; the tab
 * renders no peek on its own (guarded in `GitTab.test.tsx`).
 */
const rig = mountGitHarness();

/** Switch the tab to History mode. */
async function openHistory() {
  const historyBtn = [
    ...rig.host.querySelectorAll("button.git__modebtn"),
  ].find((el) => el.textContent === "History") as HTMLButtonElement;
  await act(async () => historyBtn.click());
}

/** A row of the tab's own list (not the peek's rail). */
function listRow(subject: string) {
  return [...rig.host.querySelectorAll(".git__list button.git__row")].find(
    (el) => el.textContent?.includes(subject),
  ) as HTMLButtonElement;
}

describe("opening a working-tree change", () => {
  it("clicking a row opens the diff peek with the parsed hunk", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus({
      entries: [
        { path: "src/app.ts", origPath: null, staged: ".", unstaged: "M", untracked: false, conflicted: false },
        { path: "notes.md", origPath: null, staged: ".", unstaged: ".", untracked: true, conflicted: false },
      ],
    }));
    const ctx = makeCtx(git);
    setRuntime(ctx);

    await rig.render();
    const row = [...rig.host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("app.ts"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      (row as HTMLButtonElement).click();
    });

    expect(git.diffFile).toHaveBeenCalledWith("/repo", "src/app.ts", {
      staged: false,
    });
    // ONCE. The peek joins the tab's settled status feed, so there is no
    // cold `version` tick to re-run the fetch — a private feed per mount read
    // the same diff twice on every open.
    expect(git.diffFile).toHaveBeenCalledTimes(1);
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(rig.host.textContent).toContain("goodbye");

    // The rail is there on the first frame, not after a second round trip.
    const aside = rig.host.querySelector(".peek__aside")!;
    expect(aside.textContent).toContain("app.ts");
    expect(aside.textContent).toContain("notes.md");
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "app.ts",
    );

    // Clicking a sibling switches the peek to ITS diff in place.
    const sibling = [...aside.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("notes.md"),
    ) as HTMLButtonElement;
    await act(async () => sibling.click());
    expect(ctx.services.fs.readFile).toHaveBeenCalledWith("/repo/notes.md");
    expect(rig.host.textContent).toContain("brand new");
    expect(
      rig.host.querySelector(".peek__aside .git__row--on")?.textContent,
    ).toContain("notes.md");
  });

  it("arrow keys walk the peek rail: up/down by file, left/right by directory", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus({
      entries: [
        { path: "src/app.ts", origPath: null, staged: ".", unstaged: "M", untracked: false, conflicted: false },
        { path: "src/util.ts", origPath: null, staged: ".", unstaged: "M", untracked: false, conflicted: false },
        { path: "notes.md", origPath: null, staged: ".", unstaged: ".", untracked: true, conflicted: false },
      ],
    }));
    const ctx = makeCtx(git);
    setRuntime(ctx);

    await rig.render();
    const row = [...rig.host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("app.ts"),
    ) as HTMLButtonElement;
    await act(async () => row.click());

    const marked = () =>
      rig.host.querySelector(".peek__aside .git__row--on")?.textContent;
    const press = (key: string) =>
      act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, cancelable: true }),
        );
      });

    // Down: the next file in the rail's order.
    await press("ArrowDown");
    expect(marked()).toContain("util.ts");
    expect(git.diffFile).toHaveBeenLastCalledWith("/repo", "src/util.ts", {
      staged: false,
    });

    // Right: the first file of the next directory group (src/ → root).
    await press("ArrowRight");
    expect(marked()).toContain("notes.md");
    expect(ctx.services.fs.readFile).toHaveBeenCalledWith("/repo/notes.md");

    // Left: back to the previous group's FIRST file.
    await press("ArrowLeft");
    expect(marked()).toContain("app.ts");

    // Up at the top clamps — the selection stays put.
    await press("ArrowUp");
    expect(marked()).toContain("app.ts");
  });

  it("an untracked row renders the file's content as all-added, via fs", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus({
      entries: [
        { path: "notes.md", origPath: null, staged: ".", unstaged: ".", untracked: true, conflicted: false },
      ],
    }));
    const ctx = makeCtx(git);
    setRuntime(ctx);

    await rig.render();
    const row = [...rig.host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("notes.md"),
    );
    await act(async () => {
      (row as HTMLButtonElement).click();
    });

    expect(git.diffFile).not.toHaveBeenCalled();
    expect(ctx.services.fs.readFile).toHaveBeenCalledWith("/repo/notes.md");
    expect(rig.host.textContent).toContain("brand new");
  });
});

describe("opening a history scope", () => {
  it("opens a commit straight in the peek, seeded to its first file", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    const fork = "f0".repeat(20);
    git.histories.set("/repo", {
      forkSha: fork,
      ahead: 2,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "add feature" },
        { sha: "b2".repeat(20), author: "Agent", timestamp: 1_750_000_000, subject: "fix tests" },
        { sha: fork, author: "Me", timestamp: 1_740_000_000, subject: "base work" },
      ],
    });
    const commitSha = "a1".repeat(20);
    git.changed.set(`${commitSha}^..${commitSha}`, [
      { path: "src/feature.ts", origPath: null, code: "A" },
    ]);
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    // The rail fetches the commit's files and seeds the first one, whose
    // range diff fills the body.
    await act(async () => listRow("add feature").click());
    expect(git.changedFiles).toHaveBeenCalledWith(
      "/repo",
      `${commitSha}^`,
      commitSha,
    );
    await act(async () => {});
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "src/feature.ts", {
      from: `${commitSha}^`,
      to: commitSha,
    });
    expect(rig.host.textContent).toContain("goodbye");
    // The rail names the commit and lists its files, the seeded one marked.
    const aside = rig.host.querySelector(".peek__aside")!;
    expect(aside.textContent).toContain("add feature");
    expect(aside.textContent).toContain("a1a1a1a");
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "feature.ts",
    );

    // Closing the peek returns to the commit list; nothing slid in behind it.
    await act(async () => {
      (rig.host.querySelector(".peek") as HTMLElement).click();
    });
    expect(rig.host.querySelector(".peek")).toBeNull();
    expect(rig.host.textContent).toContain("fix tests");
  });

  it("the since-fork peek diffs against the working tree (open-ended range)", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    const fork = "f0".repeat(20);
    git.histories.set("/repo", {
      forkSha: fork,
      ahead: 1,
      commits: [
        { sha: "c3".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "work" },
      ],
    });
    git.changed.set(`${fork}..`, [
      { path: "net.ts", origPath: null, code: "M" },
    ]);
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    const pin = rig.host.querySelector(
      "button.git__row--pin",
    ) as HTMLButtonElement;
    await act(async () => pin.click());
    expect(git.changedFiles).toHaveBeenCalledWith("/repo", fork, undefined);
    await act(async () => {});
    // Opening the sweep peeks the seeded file's range diff — open-ended, so
    // it reaches the working tree. The rail names the sweep, lists its files.
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "net.ts", {
      from: fork,
      to: undefined,
    });
    const aside = rig.host.querySelector(".peek__aside")!;
    expect(aside.textContent).toContain("Since fork");
    expect(aside.textContent).toContain("f0f0f0f");
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "net.ts",
    );
  });

  it("an empty history scope opens the peek and says so, not Loading forever", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: "f0".repeat(20),
      ahead: 1,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "empty commit" },
      ],
    });
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();
    await act(async () => listRow("empty commit").click());
    await act(async () => {});

    // The scope resolves to no files — the rail carries the note and the
    // body stays blank, instead of hanging on "Loading…" forever.
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(rig.host.querySelector(".peek__aside")?.textContent).toContain(
      "Nothing changed here.",
    );
    expect(rig.host.querySelector(".peek__body")?.textContent).not.toContain(
      "Loading…",
    );
  });

  it("arrow keys walk the history peek's rail after the first file is seeded", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "add feature" },
      ],
    });
    const commitSha = "a1".repeat(20);
    git.changed.set(`${commitSha}^..${commitSha}`, [
      { path: "src/one.ts", origPath: null, code: "A" },
      { path: "src/two.ts", origPath: null, code: "M" },
    ]);
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();
    await act(async () => listRow("add feature").click());
    await act(async () => {});

    // The rail seeded the first file and its range diff loaded.
    const aside = rig.host.querySelector(".peek__aside")!;
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "one.ts",
    );
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "src/one.ts", {
      from: `${commitSha}^`,
      to: commitSha,
    });

    // ArrowDown walks the rail to the second file — range diff, marked.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }),
      );
    });
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "two.ts",
    );
    expect(git.diffFile).toHaveBeenLastCalledWith("/repo", "src/two.ts", {
      from: `${commitSha}^`,
      to: commitSha,
    });
  });

  it("closing the peek mid-seed is safe — the pending fetch is cancelled, no revival", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "add feature" },
      ],
    });
    // A deferred file list so the seed cannot land before we close.
    let resolveFiles!: (v: GitChangedFile[]) => void;
    git.changedFiles = vi.fn(
      async () =>
        new Promise<GitChangedFile[]>((r) => {
          resolveFiles = r;
        }),
    );
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();
    await act(async () => listRow("add feature").click());
    // Peek open, seed still pending (row null).
    expect(rig.host.querySelector(".peek")).toBeTruthy();

    // Close BEFORE the file list resolves.
    await act(async () => {
      (rig.host.querySelector(".peek") as HTMLElement).click();
    });
    expect(rig.host.querySelector(".peek")).toBeNull();

    // The late resolution must not revive the dismissed peek — the rail's
    // fetch effect marked itself cancelled on unmount.
    await act(async () =>
      resolveFiles([{ path: "src/x.ts", origPath: null, code: "A" }]),
    );
    await act(async () => {});
    expect(rig.host.querySelector(".peek")).toBeNull();
  });

  it("opening a different commit after closing shows the new commit's files, not the old", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_001, subject: "first commit" },
        { sha: "b2".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "second commit" },
      ],
    });
    const a = "a1".repeat(20);
    const b = "b2".repeat(20);
    git.changed.set(`${a}^..${a}`, [{ path: "src/a.ts", origPath: null, code: "A" }]);
    git.changed.set(`${b}^..${b}`, [{ path: "src/b.ts", origPath: null, code: "M" }]);
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();

    // First commit -> seeds a.ts and its range diff.
    await act(async () => listRow("first commit").click());
    await act(async () => {});
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "src/a.ts", {
      from: `${a}^`,
      to: a,
    });

    // Close, then open the other commit — its files/diff load; A's don't leak.
    await act(async () => {
      (rig.host.querySelector(".peek") as HTMLElement).click();
    });
    await act(async () => listRow("second commit").click());
    await act(async () => {});
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(git.diffFile).toHaveBeenLastCalledWith("/repo", "src/b.ts", {
      from: `${b}^`,
      to: b,
    });
    expect(
      rig.host.querySelector(".peek__aside .git__row--on")?.textContent,
    ).toContain("b.ts");
  });

  it("a status refresh while a history scope is waiting refetches its file list", async () => {
    vi.useFakeTimers();
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
      ahead: null,
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "add feature" },
      ],
    });
    // A never-resolving fetch keeps the scope waiting (row null) throughout,
    // so the refresh lands in the null-row window the gap is about.
    git.changedFiles = vi.fn(
      async () => new Promise<GitChangedFile[]>(() => {}),
    );
    setRuntime(makeCtx(git));

    await rig.render();
    await openHistory();
    await act(async () => listRow("add feature").click());
    await rig.settle(0);

    // Waiting — no file seeded yet.
    expect(rig.host.querySelector(".peek")).toBeTruthy();
    expect(rig.host.querySelector(".peek__aside .git__row--on")).toBeNull();

    // A repo change bumps the status feed's version; the rail refetches the
    // scope's files even though no file is chosen yet.
    const before = git.changedFiles.mock.calls.length;
    git.fireChange("/repo");
    await rig.settle(301);
    expect(git.changedFiles.mock.calls.length).toBeGreaterThan(before);
    expect(rig.host.querySelector(".peek")).toBeTruthy();
  });
});
