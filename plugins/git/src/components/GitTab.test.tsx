// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
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
  const watchers = new Map<string, Set<() => void>>();
  return {
    statuses,
    status: vi.fn(async (repo: string) => {
      const st = statuses.get(repo);
      if (!st) throw new Error(`not a git repository: ${repo}`);
      return st;
    }),
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
      git: { status: git.status, diffFile: git.diffFile, watch: git.watch },
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

  it("surfaces a status failure instead of a stuck spinner", async () => {
    const git = makeGit(); // no statuses registered → status() rejects
    setRuntime(makeCtx(git));

    await render();

    expect(host.textContent).toContain("not a git repository");
  });
});
