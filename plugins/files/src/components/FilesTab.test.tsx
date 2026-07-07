// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FsEntry,
  FsFile,
  PluginContext,
  WorkspaceSnapshot,
} from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { FilesTab } from "./FilesTab";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: WorkspaceSnapshot = {
  id: "ws-1",
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
  return {
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
    opener: { openUrl: vi.fn(async () => {}), openPath: vi.fn(async () => {}) },
  };
}

function makeCtx(fs: ReturnType<typeof makeFs>): PluginContext {
  return {
    services: {
      fs: { readDir: fs.readDir, readFile: fs.readFile },
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

describe("FilesTab", () => {
  let fs: ReturnType<typeof makeFs>;
  let host: HTMLElement;
  let root: Root;

  const mount = async () => {
    await act(async () => {
      root.render(createElement(FilesTab, { workspace, selectedPaneId: null }));
    });
    // Flush the root readDir kicked off on mount.
    await act(async () => {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("previews a file's text when it is selected", async () => {
    await mount();

    await act(async () => rowByName("readme.md")!.click());
    await act(async () => {});

    expect(fs.readFile).toHaveBeenCalledWith("/repo/readme.md");
    expect(document.querySelector(".files__vname")?.textContent).toBe(
      "readme.md",
    );
    expect(document.body.textContent).toContain("second line");
  });

  it("selecting a file does not read it as a directory", async () => {
    await mount();
    await act(async () => rowByName("readme.md")!.click());
    await act(async () => {});
    // A file click drives readFile, never readDir on that path.
    expect(fs.readDir).not.toHaveBeenCalledWith("/repo/readme.md");
  });
});
