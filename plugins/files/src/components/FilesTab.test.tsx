// @vitest-environment happy-dom
import { act, createElement, Fragment, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestOpen, takeOpenRequest } from "../openRequests";
import type {
  FsEntry,
  FsFile,
  PluginContext,
  WorkspaceSnapshot,
} from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { FilesTab } from "./FilesTab";
import { FilesOverlay } from "./FilesOverlay";

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

const dir = (name: string): FsEntry => ({
  name,
  path: `/repo/${name}`,
  kind: "dir",
});
const file = (name: string, size = 10): FsEntry => ({
  name,
  path: `/repo/${name}`,
  kind: "file",
  size,
});

/** A fake project fs keyed by path — enough to drive the tab end to end. */
function makeFs() {
  const dirs: Record<string, FsEntry[]> = {
    "/repo": [file("readme.md"), dir("src")],
    "/repo/src": [file("main.ts", 42)],
  };
  const files: Record<string, FsFile> = {
    "/repo/readme.md": {
      path: "/repo/readme.md",
      text: "# title\nsecond line",
      isBinary: false,
      size: 19,
      truncated: false,
    },
  };
  const watchers = new Map<string, Set<() => void>>();
  return {
    dirs, // exposed so a test can mutate a listing, then fireChange
    readDir: vi.fn(async (path: string) => dirs[path] ?? []),
    readFile: vi.fn(
      async (path: string): Promise<FsFile> =>
        files[path] ?? {
          path,
          text: "",
          isBinary: false,
          size: 0,
          truncated: false,
        },
    ),
    watch: vi.fn((path: string, onChange: () => void) => {
      let set = watchers.get(path);
      if (!set) {
        set = new Set();
        watchers.set(path, set);
      }
      set.add(onChange);
      return { dispose: () => void set!.delete(onChange) };
    }),
    /** Simulate an OS change event for a watched directory. */
    fireChange: (path: string) => watchers.get(path)?.forEach((cb) => cb()),
    opener: { openUrl: vi.fn(async () => {}), openPath: vi.fn(async () => {}) },
  };
}

function makeCtx(fs: ReturnType<typeof makeFs>): PluginContext {
  return {
    services: {
      fs: { readDir: fs.readDir, readFile: fs.readFile, watch: fs.watch },
      opener: fs.opener,
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

const treeNames = () =>
  [...document.querySelectorAll(".files__name")].map((n) => n.textContent);

const rowByName = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".files__row")).find(
    (row) => row.querySelector(".files__name")?.textContent === name,
  );

/** The keyboard-focused row's name (the `--sel` highlight follows the cursor). */
const activeName = () =>
  document.querySelector(".files__row--sel .files__name")?.textContent ?? null;

/** Double-click a row — opening a file is a double-click gesture; a single
 * click only selects. */
const dblclick = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

/** Fire an arrow key on the focusable tree container. */
const press = (key: string) =>
  act(() => {
    document
      .querySelector(".files__tree")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

describe("FilesTab", () => {
  let fs: ReturnType<typeof makeFs>;
  let host: HTMLElement;
  let root: Root;

  // The real composition: the tab (navigator) plus the resident overlay (the
  // peek's single consumer) — opens flow from one to the other over the bus.
  const mount = async () => {
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(FilesTab, { workspace, selectedPaneId: null }),
          createElement(FilesOverlay, null),
        ),
      );
    });
    // Flush the root readDir kicked off on mount.
    await act(async () => {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
    takeOpenRequest(); // a leftover parked request must not leak between tests
    fs = makeFs();
    setRuntime(makeCtx(fs));
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    setRuntime(null);
  });

  it("loads the workspace root and lists children directories-first", async () => {
    await mount();
    expect(fs.readDir).toHaveBeenCalledWith("/repo");
    expect(treeNames()).toEqual(["src", "readme.md"]);
  });

  it("lazily loads a directory's children only when it is expanded", async () => {
    await mount();
    expect(fs.readDir).not.toHaveBeenCalledWith("/repo/src");

    await act(async () => rowByName("src")!.click());
    await act(async () => {});

    expect(fs.readDir).toHaveBeenCalledWith("/repo/src");
    expect(treeNames()).toEqual(["src", "main.ts", "readme.md"]);
  });

  it("auto-refreshes a watched directory when it changes on disk", async () => {
    await mount();
    expect(treeNames()).toEqual(["src", "readme.md"]);
    // The root is watched from the first load.
    expect(fs.watch).toHaveBeenCalledWith("/repo", expect.any(Function));

    // A new file lands on disk; the OS watcher fires for that directory.
    fs.dirs["/repo"] = [file("readme.md"), dir("src"), file("new.ts")];
    fs.fireChange("/repo");
    // Wait out the debounce (250ms), then let the re-read settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });

    expect(treeNames()).toEqual(["src", "new.ts", "readme.md"]);
  });

  it("a single click only selects a file — no peek, no read", async () => {
    await mount();
    await act(async () => rowByName("readme.md")!.click());
    await act(async () => {});
    expect(document.querySelector(".peek")).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
    // The click did take the cursor, so keyboard flow continues from here.
    expect(activeName()).toBe("readme.md");
  });

  it("previews a file's text when it is opened", async () => {
    await mount();

    await act(async () => dblclick(rowByName("readme.md")!));
    await act(async () => {});

    expect(fs.readFile).toHaveBeenCalledWith("/repo/readme.md");
    expect(document.querySelector(".peek__name")?.textContent).toBe(
      "readme.md",
    );
    expect(document.body.textContent).toContain("second line");
  });

  it("toggles line wrapping in the peek", async () => {
    await mount();
    // The wrap control belongs to the raw line view — readme.md opens as a
    // rendered document now — so exercise it on a code file.
    await act(async () => rowByName("src")!.click());
    await act(async () => {});
    await act(async () => dblclick(rowByName("main.ts")!));
    await act(async () => {});
    const wrapBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle line wrapping"]',
    )!;
    expect(document.querySelector(".files__code--wrap")).toBeNull();
    await act(async () => wrapBtn.click());
    expect(document.querySelector(".files__code--wrap")).not.toBeNull();
  });

  it("closes the peek on a backdrop click", async () => {
    await mount();
    await act(async () => dblclick(rowByName("readme.md")!));
    await act(async () => {});
    expect(document.querySelector(".peek")).not.toBeNull();
    await act(async () =>
      document.querySelector<HTMLElement>(".peek")!.click(),
    );
    expect(document.querySelector(".peek")).toBeNull();
  });

  it("tags tree rows with their path for dragging into a pane", async () => {
    await mount();
    expect(rowByName("readme.md")!.getAttribute("data-kd-drag-path")).toBe(
      "/repo/readme.md",
    );
    expect(rowByName("src")!.getAttribute("data-kd-drag-path")).toBe("/repo/src");
  });

  it("opening a file does not read it as a directory", async () => {
    await mount();
    await act(async () => dblclick(rowByName("readme.md")!));
    await act(async () => {});
    // Opening a file drives readFile, never readDir on that path.
    expect(fs.readFile).toHaveBeenCalledWith("/repo/readme.md");
    expect(fs.readDir).not.toHaveBeenCalledWith("/repo/readme.md");
  });

  it("moves the cursor down and up with the arrow keys", async () => {
    await mount();
    press("ArrowDown"); // no cursor yet → first row
    expect(activeName()).toBe("src");
    press("ArrowDown");
    expect(activeName()).toBe("readme.md");
    press("ArrowUp");
    expect(activeName()).toBe("src");
    // Arrows only move the cursor now — they never open a file.
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("expands with Right, descends into the child, and returns to the parent with Left", async () => {
    await mount();
    press("ArrowDown"); // src
    press("ArrowRight"); // expand src
    await act(async () => {});
    expect(fs.readDir).toHaveBeenCalledWith("/repo/src");
    expect(activeName()).toBe("src"); // expand keeps the cursor put

    press("ArrowRight"); // step into main.ts
    expect(activeName()).toBe("main.ts");

    press("ArrowLeft"); // back to the parent
    expect(activeName()).toBe("src");

    press("ArrowLeft"); // collapse src
    expect(document.querySelector(".files__row[aria-expanded='false']")).not.toBeNull();
  });

  it("opens the focused file with Enter and closes the preview with Escape", async () => {
    await mount();
    press("ArrowDown"); // src
    press("ArrowDown"); // readme.md (a file)
    press("Enter"); // open it
    await act(async () => {});
    expect(fs.readFile).toHaveBeenCalledWith("/repo/readme.md");
    expect(document.querySelector(".peek__name")?.textContent).toBe(
      "readme.md",
    );

    // Escape from the detail drills back out to the tree.
    await act(async () => {
      document
        .querySelector(".peek")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".peek")).toBeNull();
    expect(document.querySelector(".files__list")).not.toBeNull();
  });

  it("Enter on a directory toggles it instead of opening a preview", async () => {
    await mount();
    press("ArrowDown"); // src (a directory)
    press("Enter"); // expand
    await act(async () => {});
    expect(fs.readDir).toHaveBeenCalledWith("/repo/src");
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(document.querySelector(".peek")).toBeNull();
  });

  it("consumes an open request parked BEFORE mount (activation races the click)", async () => {
    requestOpen({ path: "/repo/readme.md" });
    await mount();
    await act(async () => {});
    expect(document.querySelector(".peek__name")?.textContent).toBe(
      "readme.md",
    );
    // A terminal-link open has no tree root: the breadcrumb shows the
    // ABSOLUTE path, not a fake root-relative remainder.
    expect(document.querySelector(".peek__path")?.textContent).toBe(
      "/repo/readme.md",
    );
    expect(document.body.textContent).toContain("second line");
  });

  it("opens a live request while already mounted", async () => {
    await mount();
    expect(document.querySelector(".peek")).toBeNull();
    await act(async () => requestOpen({ path: "/repo/readme.md" }));
    await act(async () => {});
    expect(document.querySelector(".peek")).not.toBeNull();
  });

  it("survives StrictMode's double-invoked effects — the parked request still opens", async () => {
    // The dev app renders under StrictMode: mount effects run twice. The
    // root-reset effect's SECOND run used to wipe the preview the consumer's
    // first run had just set — the dock reveal then "opened nothing".
    requestOpen({ path: "/repo/readme.md" });
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(FilesTab, { workspace, selectedPaneId: null }),
          createElement(FilesOverlay, null),
        ),
      );
    });
    await act(async () => {});
    expect(document.querySelector(".peek__name")?.textContent).toBe(
      "readme.md",
    );
  });
});
