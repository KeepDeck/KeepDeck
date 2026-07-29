import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import type {
  GitBranches,
  GitChangedFile,
  GitHistory,
  GitStatus,
  PluginContext,
  WorkspaceSnapshot,
} from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { takePeekRequest } from "../peekRequests";
import { GitTab } from "./GitTab";
import { GitDiffOverlay } from "./GitDiffOverlay";

/**
 * Shared rig for the Git plugin's component tests: a fake git service, a
 * plugin context around it, and a mounted tab + resident overlay.
 *
 * The tab and the overlay mount as SIBLINGS — the shape the host puts them in
 * (the dock panel and `PluginOverlays` are siblings in the composition root).
 * Anything asserting on a peek is therefore exercising the real path: the tab
 * publishes a request, the resident overlay renders the diff.
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export const workspace: WorkspaceSnapshot = {
  id: "ws-1",
  instance: "instance-1",
  name: "app",
  cwd: "/repo",
  panes: [
    { id: "p1", name: "agent 1", cwd: "/wt/one", branch: "kd/app/1", agentType: "claude" },
  ],
};

export const cleanStatus = (over: Partial<GitStatus> = {}): GitStatus => ({
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
export function makeGit() {
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
    diffFile: vi.fn(async () => "@@ -1 +1 @@\n-hello\n+goodbye\n"),
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

export function makeCtx(git: ReturnType<typeof makeGit>): PluginContext {
  return {
    // The resident diff overlay subscribes to these to drop a diff whose
    // workspace the user has left; nothing here fires them.
    events: {
      onPaneSelected: () => ({ dispose: vi.fn() }),
      onWorkspaceClosed: () => ({ dispose: vi.fn() }),
      onDeckChanged: () => ({ dispose: vi.fn() }),
    },
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

export interface GitHarness {
  /** The mount point of the CURRENT test — read it per use, not once. */
  readonly host: HTMLDivElement;
  /** Tab + resident overlay, the way the host mounts them. */
  render(selectedPaneId?: string | null): Promise<void>;
  /** The tab alone, with no consumer for what it opens. */
  renderTabOnly(selectedPaneId?: string | null): Promise<void>;
  /** Flush the debounce timer AND the reads it schedules. */
  settle(ms: number): Promise<void>;
}

/** Register the mount/teardown hooks for a test file and hand back its rig.
 * Call once at the top level of the file. */
export function mountGitHarness(): GitHarness {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    // Unmounting is what closes the status feeds: the last surface to
    // unsubscribe disposes the repo's feed and its watch. Nothing else has to
    // reach into that module state, here or in production.
    await act(async () => root.unmount());
    host.remove();
    setRuntime(null);
    // A test that opens a diff without a consumer leaves the request parked
    // in the module's slot; drain it so it can't open a peek in the next one.
    takePeekRequest();
    vi.useRealTimers();
  });

  return {
    get host() {
      return host;
    },
    async render(selectedPaneId: string | null = null) {
      await act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(GitTab, { workspace, selectedPaneId }),
            createElement(GitDiffOverlay),
          ),
        );
      });
    },
    async renderTabOnly(selectedPaneId: string | null = null) {
      await act(async () => {
        root.render(createElement(GitTab, { workspace, selectedPaneId }));
      });
    },
    async settle(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
  };
}
