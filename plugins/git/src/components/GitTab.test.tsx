// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitBranches,
  GitChangedFile,
  GitHistory,
  GitStatus,
  PluginContext,
  WorkspaceSnapshot,
} from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { GitTab } from "./GitTab";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: WorkspaceSnapshot = {
  id: "ws-1",
  name: "app",
  cwd: "/repo",
  panes: [
    { id: "p1", name: "agent 1", cwd: "/wt/one", branch: "kd/app/1", agentType: "claude" },
  ],
};

const cleanStatus = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main",
  detached: false,
  oid: "abc1234def",
  upstream: null,
  ahead: null,
  behind: null,
  entries: [],
  ...over,
});

/** A fake git service keyed by repo path — enough to drive the tab end to end. */
function makeGit() {
  const statuses = new Map<string, GitStatus>();
  const histories = new Map<string, GitHistory>();
  const branchLists = new Map<string, GitBranches>();
  const changed = new Map<string, GitChangedFile[]>();
  const watchers = new Map<string, Set<() => void>>();
  return {
    statuses,
    histories,
    branchLists,
    changed, // keyed `${from}..${to ?? ""}`
    status: vi.fn(async (repo: string) => {
      const st = statuses.get(repo);
      if (!st) throw new Error(`not a git repository: ${repo}`);
      return st;
    }),
    history: vi.fn(async (repo: string, opts?: { limit?: number }) => {
      const h = histories.get(repo);
      if (!h) throw new Error(`no history for: ${repo}`);
      // The real backend windows the log by the asked limit.
      return { ...h, commits: h.commits.slice(0, opts?.limit ?? 50) };
    }),
    changedFiles: vi.fn(
      async (_repo: string, from: string, to?: string) =>
        changed.get(`${from}..${to ?? ""}`) ?? [],
    ),
    branches: vi.fn(
      async (repo: string) =>
        branchLists.get(repo) ?? { current: "main", branches: ["main"] },
    ),
    diffFile: vi.fn(
      async () => "@@ -1 +1 @@\n-hello\n+goodbye\n",
    ),
    watch: vi.fn((repo: string, onChange: () => void) => {
      let set = watchers.get(repo);
      if (!set) {
        set = new Set();
        watchers.set(repo, set);
      }
      set.add(onChange);
      return { dispose: () => void set!.delete(onChange) };
    }),
    /** Simulate the backend's repo-changed event. */
    fireChange: (repo: string) => watchers.get(repo)?.forEach((cb) => cb()),
    watcherCount: (repo: string) => watchers.get(repo)?.size ?? 0,
  };
}

function makeCtx(git: ReturnType<typeof makeGit>): PluginContext {
  return {
    services: {
      git: {
        status: git.status,
        diffFile: git.diffFile,
        history: git.history,
        branches: git.branches,
        changedFiles: git.changedFiles,
        watch: git.watch,
      },
      fs: {
        readDir: vi.fn(async () => []),
        readFile: vi.fn(async (path: string) => ({
          path,
          text: "brand new\n",
          isBinary: false,
          size: 10,
          truncated: false,
        })),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setRuntime(null);
  vi.useRealTimers();
});

async function render(selectedPaneId: string | null = null) {
  await act(async () => {
    root.render(createElement(GitTab, { workspace, selectedPaneId }));
  });
}

/** Flush the debounce timer AND the reads it schedules. */
async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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

    await render();

    expect(host.textContent).toContain("main");
    expect(host.textContent).toContain("↑2 ↓1");
    expect(host.textContent).toContain("Changes");
    expect(host.textContent).toContain("app.ts");
    expect(host.textContent).toContain("Untracked");
    expect(host.textContent).toContain("notes.md");
    // Sections with no rows don't render at all.
    expect(host.textContent).not.toContain("Staged");
    expect(host.textContent).not.toContain("Conflicts");
  });

  it("defaults to the highlighted pane's worktree and says so when it is clean", async () => {
    const git = makeGit();
    git.statuses.set("/wt/one", cleanStatus({ branch: "kd/app/1" }));
    setRuntime(makeCtx(git));

    await render("p1");

    expect(git.status).toHaveBeenCalledWith("/wt/one");
    expect(host.textContent).toContain("kd/app/1");
    expect(host.textContent).toContain("No changes");
  });

  it("watch events re-read the status after the debounce — no refresh button exists", async () => {
    vi.useFakeTimers();
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    setRuntime(makeCtx(git));

    await render();
    await settle(0);
    expect(host.textContent).toContain("No changes");
    expect(host.querySelector("button[title*='efresh']")).toBeNull();

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

    await settle(299);
    // Still within the debounce window — no read yet.
    expect(git.status.mock.calls.length).toBe(before);

    await settle(2);
    expect(git.status.mock.calls.length).toBe(before + 1);
    expect(host.textContent).toContain("hot.ts");
  });

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

    await render();
    const row = [...host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("app.ts"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      (row as HTMLButtonElement).click();
    });

    expect(git.diffFile).toHaveBeenCalledWith("/repo", "src/app.ts", {
      staged: false,
    });
    expect(host.querySelector(".peek")).toBeTruthy();
    expect(host.textContent).toContain("goodbye");

    // The rail lists the whole working-tree set, the open row marked.
    const aside = host.querySelector(".peek__aside")!;
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
    expect(host.textContent).toContain("brand new");
    expect(
      host.querySelector(".peek__aside .git__row--on")?.textContent,
    ).toContain("notes.md");
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

    await render();
    const row = [...host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("notes.md"),
    );
    await act(async () => {
      (row as HTMLButtonElement).click();
    });

    expect(git.diffFile).not.toHaveBeenCalled();
    expect(ctx.services.fs.readFile).toHaveBeenCalledWith("/repo/notes.md");
    expect(host.textContent).toContain("brand new");
  });

  it("tears down the repo watcher when the root switches", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.statuses.set("/wt/one", cleanStatus({ branch: "kd/app/1" }));
    setRuntime(makeCtx(git));

    await render();
    expect(git.watcherCount("/repo")).toBe(1);

    // Highlighting the pane re-roots the tab onto its worktree.
    await render("p1");
    expect(git.watcherCount("/repo")).toBe(0);
    expect(git.watcherCount("/wt/one")).toBe(1);
  });

  it("History mode lists commits since the fork and drills into a commit's diff", async () => {
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
    const commitSha = "a1".repeat(20);
    git.changed.set(`${commitSha}^..${commitSha}`, [
      { path: "src/feature.ts", origPath: null, code: "A" },
    ]);
    setRuntime(makeCtx(git));

    await render();
    const historyBtn = [...host.querySelectorAll("button.git__modebtn")].find(
      (el) => el.textContent === "History",
    ) as HTMLButtonElement;
    await act(async () => historyBtn.click());

    // Commits newest-first plus the pinned since-fork summary; the count is
    // the branch's own side of the fork, not the listing length.
    expect(host.textContent).toContain("Since fork");
    expect(host.textContent).toContain("2 commits");
    expect(host.textContent).toContain("add feature");
    expect(host.textContent).toContain("fix tests");
    expect(host.textContent).toContain("a1a1a1a");
    // The full history is visible too, split by the fork-point divider:
    // branch work above, base history below.
    expect(host.textContent).toContain("base work");
    expect(host.textContent).toContain("older base work");
    const divider = host.querySelector(".git__forkline");
    expect(divider).toBeTruthy();

    // Drill into the newest commit → its file list, fetched parent..self.
    const commitRow = [...host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("add feature"),
    ) as HTMLButtonElement;
    await act(async () => commitRow.click());
    expect(git.changedFiles).toHaveBeenCalledWith(
      "/repo",
      `${commitSha}^`,
      commitSha,
    );
    expect(host.textContent).toContain("feature.ts");
    // The drill slides in on the track; the list pane goes inert behind it.
    expect(host.querySelector(".git__track--drill")).toBeTruthy();
    const panes = host.querySelectorAll(".git__slidepane");
    expect(panes[0].hasAttribute("inert")).toBe(true);
    expect(panes[1].hasAttribute("inert")).toBe(false);

    // A file opens the peek with the RANGE diff, never the index one.
    const fileRow = [...host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("feature.ts"),
    ) as HTMLButtonElement;
    await act(async () => fileRow.click());
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "src/feature.ts", {
      from: `${commitSha}^`,
      to: commitSha,
    });
    expect(host.querySelector(".peek")).toBeTruthy();
    expect(host.textContent).toContain("goodbye");
    // The rail names the commit and lists its files, the open one marked.
    const aside = host.querySelector(".peek__aside")!;
    expect(aside.textContent).toContain("add feature");
    expect(aside.textContent).toContain("a1a1a1a");
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "feature.ts",
    );

    // Backing out of the drill returns to the commit list.
    await act(async () => {
      (host.querySelector(".peek") as HTMLElement).click(); // close peek
    });
    const back = host.querySelector("button.git__drillback") as HTMLButtonElement;
    await act(async () => back.click());
    // The track slides back; the list pane is live again and the drill pane
    // keeps its content (inert) through the exit animation.
    expect(host.querySelector(".git__track--drill")).toBeNull();
    const panesAfter = host.querySelectorAll(".git__slidepane");
    expect(panesAfter[0].hasAttribute("inert")).toBe(false);
    expect(panesAfter[1].hasAttribute("inert")).toBe(true);
    expect(host.textContent).toContain("fix tests");
    expect(host.textContent).toContain("feature.ts");
  });

  it("the since-fork drill diffs against the working tree (open-ended range)", async () => {
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

    await render();
    const historyBtn = [...host.querySelectorAll("button.git__modebtn")].find(
      (el) => el.textContent === "History",
    ) as HTMLButtonElement;
    await act(async () => historyBtn.click());

    const pin = host.querySelector("button.git__row--pin") as HTMLButtonElement;
    await act(async () => pin.click());
    expect(git.changedFiles).toHaveBeenCalledWith("/repo", fork, undefined);
    expect(host.textContent).toContain("net.ts");

    // Opening a file from the sweep peeks its range diff; the rail names the
    // sweep and lists its files.
    const fileRow = [...host.querySelectorAll("button.git__row")].find((el) =>
      el.textContent?.includes("net.ts"),
    ) as HTMLButtonElement;
    await act(async () => fileRow.click());
    expect(git.diffFile).toHaveBeenCalledWith("/repo", "net.ts", {
      from: fork,
      to: undefined,
    });
    const aside = host.querySelector(".peek__aside")!;
    expect(aside.textContent).toContain("Since fork");
    expect(aside.textContent).toContain("f0f0f0f");
    expect(aside.querySelector(".git__row--on")?.textContent).toContain(
      "net.ts",
    );
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

    await render();
    const historyBtn = [...host.querySelectorAll("button.git__modebtn")].find(
      (el) => el.textContent === "History",
    ) as HTMLButtonElement;
    await act(async () => historyBtn.click());

    expect(host.textContent).toContain("init");
    expect(host.textContent).not.toContain("Since fork");
    expect(host.querySelector(".git__forkline")).toBeNull();
  });

  it("History loads lazily in chunks of 50 and stops when the log runs dry", async () => {
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

    await render();
    const historyBtn = [...host.querySelectorAll("button.git__modebtn")].find(
      (el) => el.textContent === "History",
    ) as HTMLButtonElement;
    await act(async () => historyBtn.click());

    // First chunk: 50 commit rows and a live sentinel.
    expect(git.history).toHaveBeenCalledWith("/repo", { limit: 50 });
    expect(host.querySelectorAll("button.git__row").length).toBe(50);
    const more = host.querySelector("button.git__more") as HTMLButtonElement;
    expect(more).toBeTruthy();

    // The next chunk widens the window; a 60-commit repo underfills it, so
    // the sentinel retires — the list is complete.
    await act(async () => more.click());
    expect(git.history).toHaveBeenCalledWith("/repo", { limit: 100 });
    expect(host.querySelectorAll("button.git__row").length).toBe(60);
    expect(host.querySelector("button.git__more")).toBeNull();
  });

  it("History can browse a branch that is not checked out", async () => {
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

    await render();
    const historyBtn = [...host.querySelectorAll("button.git__modebtn")].find(
      (el) => el.textContent === "History",
    ) as HTMLButtonElement;
    await act(async () => historyBtn.click());

    // The picker marks the checkout with the green-check badge, not a text
    // suffix; switching to the foreign branch walks it by ref — no checkout
    // involved.
    expect(host.querySelector(".git__refcur .git__refcheck")).toBeTruthy();
    expect(host.textContent).not.toContain("checked out");
    git.histories.set("/repo", {
      forkSha: fork,
      ahead: 1,
      commits: [
        { sha: "a9".repeat(20), author: "Agent", timestamp: 1_760_000_100, subject: "side work" },
        { sha: fork, author: "Me", timestamp: 1_760_000_000, subject: "init" },
      ],
    });
    // The ui-kit Dropdown portals its listbox outside this component host.
    const trigger = host.querySelector(
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
    expect(host.textContent).toContain("side work");

    // Since-fork on a foreign ref pins the range's end to the ref — there is
    // no working tree to reach.
    const pin = host.querySelector("button.git__row--pin") as HTMLButtonElement;
    await act(async () => pin.click());
    expect(git.changedFiles).toHaveBeenCalledWith("/repo", fork, "kd/side/1");
  });

  it("surfaces a status failure instead of a stuck spinner", async () => {
    const git = makeGit(); // no statuses registered → status() rejects
    setRuntime(makeCtx(git));

    await render();

    expect(host.textContent).toContain("not a git repository");
  });
});
