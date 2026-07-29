// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus, PluginContext, WorkspaceSnapshot } from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { requestPeek, takePeekRequest } from "../peekRequests";
import { GitDiffOverlay } from "./GitDiffOverlay";
import { GitTab } from "./GitTab";
import type { ChangeRow } from "../domain/status";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: WorkspaceSnapshot = {
  id: "ws-1",
  instance: "instance-1",
  name: "app",
  cwd: "/repo",
  panes: [],
};

const status = (paths: string[]): GitStatus => ({
  branch: "main",
  detached: false,
  oid: "abc1234def",
  upstream: null,
  ahead: null,
  behind: null,
  entries: paths.map((path) => ({
    path,
    origPath: null,
    staged: ".",
    unstaged: "M",
    untracked: false,
    conflicted: false,
  })),
});

const row = (path: string): ChangeRow => ({
  path,
  origPath: null,
  code: "M",
  kind: "unstaged",
});

function makeCtx(over: Partial<GitStatus> | null = null): PluginContext {
  return {
    services: {
      git: {
        status: vi.fn(async () => ({ ...status(["src/app.ts"]), ...over })),
        diffFile: vi.fn(async () => "@@ -1 +1 @@\n-hello\n+goodbye\n"),
        history: vi.fn(async () => ({ commits: [], base: null })),
        branches: vi.fn(async () => ({ current: "main", branches: ["main"] })),
        changedFiles: vi.fn(async () => []),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      },
      fs: {
        readDir: vi.fn(async () => []),
        readFile: vi.fn(async () => ({
          path: "x",
          text: "",
          isBinary: false,
          size: 0,
          truncated: false,
        })),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

/** Two hosts, two roots — the shape the app mounts these in. The dock panel
 * and `PluginOverlays` are separate subtrees, so unmounting the tab (the dock
 * closing) cannot reach the overlay. Reproducing that here is the point: a
 * single tree would let React's reconciliation, not the architecture, decide
 * whether the diff survives. */
let tabHost: HTMLDivElement;
let overlayHost: HTMLDivElement;
let tabRoot: Root;
let overlayRoot: Root;

beforeEach(() => {
  tabHost = document.createElement("div");
  overlayHost = document.createElement("div");
  document.body.append(tabHost, overlayHost);
  tabRoot = createRoot(tabHost);
  overlayRoot = createRoot(overlayHost);
});

afterEach(async () => {
  await act(async () => {
    tabRoot.unmount();
    overlayRoot.unmount();
  });
  tabHost.remove();
  overlayHost.remove();
  setRuntime(null);
  takePeekRequest();
});

async function mountOverlay() {
  await act(async () => {
    overlayRoot.render(createElement(GitDiffOverlay));
  });
}

async function mountTab() {
  await act(async () => {
    tabRoot.render(
      createElement(GitTab, { workspace, selectedPaneId: null }),
    );
  });
}

describe("GitDiffOverlay", () => {
  it("renders nothing until a diff is opened", async () => {
    setRuntime(makeCtx());

    await mountOverlay();

    expect(overlayHost.querySelector(".peek")).toBeNull();
    expect(overlayHost.textContent).toBe("");
  });

  it("opens a diff with no dock tab in the tree at all", async () => {
    setRuntime(makeCtx());
    await mountOverlay();

    // No GitTab is mounted: this is the dock closed, or another tab showing.
    await act(async () => {
      requestPeek({ repo: "/repo", kind: "worktree", row: row("src/app.ts") });
    });

    expect(overlayHost.querySelector(".peek")).toBeTruthy();
    expect(overlayHost.textContent).toContain("goodbye");
  });

  it("keeps an open diff when the dock closes and the tab unmounts", async () => {
    setRuntime(makeCtx());
    await mountOverlay();
    await mountTab();

    const changeRow = [...tabHost.querySelectorAll("button.git__row")].find(
      (el) => el.textContent?.includes("app.ts"),
    );
    expect(changeRow).toBeTruthy();
    await act(async () => {
      (changeRow as HTMLButtonElement).click();
    });
    expect(overlayHost.querySelector(".peek")).toBeTruthy();

    // The dock closes: the host unmounts the panel, and with it the tab.
    await act(async () => tabRoot.unmount());

    // The diff is still on screen, still showing its file. This is the whole
    // reason it is a resident overlay rather than part of the tab.
    expect(overlayHost.querySelector(".peek")).toBeTruthy();
    expect(overlayHost.textContent).toContain("goodbye");
    expect(overlayHost.querySelector(".peek__aside")?.textContent).toContain(
      "app.ts",
    );
  });

  it("a history scope opens before any file is picked, showing the scope", async () => {
    setRuntime(makeCtx());
    await mountOverlay();

    await act(async () => {
      requestPeek({
        repo: "/repo",
        kind: "history",
        scope: { kind: "commit", sha: "abc1234def", subject: "Add a thing" },
      });
    });

    const peek = overlayHost.querySelector(".peek");
    expect(peek).toBeTruthy();
    // Waiting on its first file: the header carries the scope, the body has
    // no diff yet.
    expect(peek?.textContent).toContain("abc1234");
    expect(peek?.textContent).not.toContain("goodbye");
  });

  it("closing the diff clears it, leaving nothing behind", async () => {
    setRuntime(makeCtx());
    await mountOverlay();
    await act(async () => {
      requestPeek({ repo: "/repo", kind: "worktree", row: row("src/app.ts") });
    });
    expect(overlayHost.querySelector(".peek")).toBeTruthy();

    await act(async () => {
      (overlayHost.querySelector(".peek") as HTMLElement).click();
    });

    expect(overlayHost.querySelector(".peek")).toBeNull();
    expect(overlayHost.textContent).toBe("");
  });
});
