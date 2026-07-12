// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
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
  const changed = new Map<string, GitChangedFile[]>();
  const watchers = new Map<string, Set<() => void>>();
  return {
    statuses,
    histories,
    changed, // keyed `${from}..${to ?? ""}`
    status: vi.fn(async (repo: string) => {
      const st = statuses.get(repo);
      if (!st) throw new Error(`not a git repository: ${repo}`);
      return st;
    }),
    history: vi.fn(async (repo: string) => {
      const h = histories.get(repo);
      if (!h) throw new Error(`no history for: ${repo}`);
      return h;
    }),
    changedFiles: vi.fn(
      async (_repo: string, from: string, to?: string) =>
        changed.get(`${from}..${to ?? ""}`) ?? [],
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
      ],
    }));
    setRuntime(makeCtx(git));

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
    git.histories.set("/repo", {
      forkSha: "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
      commits: [
        { sha: "a1".repeat(20), author: "Agent", timestamp: 1_760_000_000, subject: "add feature" },
        { sha: "b2".repeat(20), author: "Agent", timestamp: 1_750_000_000, subject: "fix tests" },
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

    // Commits newest-first plus the pinned since-fork summary.
    expect(host.textContent).toContain("Since fork");
    expect(host.textContent).toContain("2 commits");
    expect(host.textContent).toContain("add feature");
    expect(host.textContent).toContain("fix tests");
    expect(host.textContent).toContain("a1a1a1a");

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

    // Backing out of the drill returns to the commit list.
    await act(async () => {
      (host.querySelector(".peek") as HTMLElement).click(); // close peek
    });
    const back = host.querySelector("button.git__drillback") as HTMLButtonElement;
    await act(async () => back.click());
    expect(host.textContent).toContain("fix tests");
  });

  it("the since-fork drill diffs against the working tree (open-ended range)", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    const fork = "f0".repeat(20);
    git.histories.set("/repo", {
      forkSha: fork,
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
  });

  it("without a fork point History is a plain log with no since-fork row", async () => {
    const git = makeGit();
    git.statuses.set("/repo", cleanStatus());
    git.histories.set("/repo", {
      forkSha: null,
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
  });

  it("surfaces a status failure instead of a stuck spinner", async () => {
    const git = makeGit(); // no statuses registered → status() rejects
    setRuntime(makeCtx(git));

    await render();

    expect(host.textContent).toContain("not a git repository");
  });
});
