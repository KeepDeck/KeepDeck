import { describe, expect, it } from "vitest";
import type { FsEntry } from "@keepdeck/plugin-api";
import {
  baseName,
  initTree,
  refreshTargets,
  setChildren,
  setError,
  setLoading,
  toggleExpanded,
  visibleRows,
} from "./tree";

const dir = (path: string): FsEntry => ({
  name: baseName(path),
  path,
  kind: "dir",
});
const file = (path: string, size?: number): FsEntry => ({
  name: baseName(path),
  path,
  kind: "file",
  size,
});

/** The visible rows as `depth:name` strings — compact assertions of shape. */
const shape = (state: ReturnType<typeof initTree>) =>
  visibleRows(state).map((row) => `${row.depth}:${row.node.name}`);

describe("initTree", () => {
  it("starts with an expanded, unloaded root and no visible rows", () => {
    const state = initTree("/repo");
    expect(state.rootPath).toBe("/repo");
    expect(state.nodes["/repo"]).toMatchObject({
      kind: "dir",
      expanded: true,
      loaded: false,
    });
    expect(visibleRows(state)).toEqual([]);
  });
});

describe("setChildren", () => {
  it("lands children sorted dirs-first and reveals them at depth 0", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [
      file("/repo/readme.md"),
      dir("/repo/src"),
    ]);
    expect(state.nodes["/repo"].loaded).toBe(true);
    expect(shape(state)).toEqual(["0:src", "0:readme.md"]);
  });

  it("keeps a file's size and is a no-op on an unknown parent", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [file("/repo/a.txt", 42)]);
    expect(state.nodes["/repo/a.txt"].size).toBe(42);
    expect(setChildren(state, "/nope", [file("/nope/x")])).toBe(state);
  });

  it("returns the SAME state when a re-read finds an unchanged listing", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/src"), file("/repo/a.txt", 1)]);
    const again = setChildren(state, "/repo", [dir("/repo/src"), file("/repo/a.txt", 1)]);
    expect(again).toBe(state); // reference-equal → no re-render on noise
  });

  it("returns a NEW state when a re-read finds a changed listing", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [file("/repo/a.txt")]);
    const changed = setChildren(state, "/repo", [
      file("/repo/a.txt"),
      file("/repo/b.txt"),
    ]);
    expect(changed).not.toBe(state);
    expect(changed.nodes["/repo/b.txt"]).toBeDefined();
  });
});

describe("toggleExpanded + lazy visibility", () => {
  it("hides a directory's loaded children until it is expanded", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/src")]);
    state = setChildren(state, "/repo/src", [file("/repo/src/main.ts")]);
    // Loaded but collapsed → the child is not visible.
    expect(shape(state)).toEqual(["0:src"]);

    state = toggleExpanded(state, "/repo/src");
    expect(shape(state)).toEqual(["0:src", "1:main.ts"]);

    state = toggleExpanded(state, "/repo/src");
    expect(shape(state)).toEqual(["0:src"]);
  });

  it("shows nothing under an expanded-but-unloaded directory", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/src")]);
    state = toggleExpanded(state, "/repo/src"); // expanded, still not loaded
    expect(shape(state)).toEqual(["0:src"]);
  });

  it("refuses to toggle a non-directory", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [file("/repo/a.txt")]);
    expect(toggleExpanded(state, "/repo/a.txt")).toBe(state);
  });
});

describe("setChildren on refresh", () => {
  it("preserves an expanded child's subtree and prunes what vanished", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/src"), file("/repo/old.txt")]);
    state = setChildren(state, "/repo/src", [file("/repo/src/main.ts")]);
    state = toggleExpanded(state, "/repo/src");
    expect(shape(state)).toEqual(["0:src", "1:main.ts", "0:old.txt"]);

    // Refresh /repo: old.txt is gone, src remains → src stays expanded/loaded.
    state = setChildren(state, "/repo", [dir("/repo/src")]);
    expect(state.nodes["/repo/old.txt"]).toBeUndefined();
    expect(state.nodes["/repo/src"]).toMatchObject({ expanded: true, loaded: true });
    expect(shape(state)).toEqual(["0:src", "1:main.ts"]);
  });

  it("prunes a whole removed subtree, not just its top node", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/pkg")]);
    state = setChildren(state, "/repo/pkg", [file("/repo/pkg/index.ts")]);
    expect(state.nodes["/repo/pkg/index.ts"]).toBeDefined();

    state = setChildren(state, "/repo", []); // pkg deleted
    expect(state.nodes["/repo/pkg"]).toBeUndefined();
    expect(state.nodes["/repo/pkg/index.ts"]).toBeUndefined();
  });
});

describe("setLoading / setError", () => {
  it("marks a node loading, then records a failure reason", () => {
    let state = initTree("/repo");
    state = setLoading(state, "/repo");
    expect(state.nodes["/repo"]).toMatchObject({ loading: true, error: undefined });

    state = setError(state, "/repo", "permission denied");
    expect(state.nodes["/repo"]).toMatchObject({
      loading: false,
      error: "permission denied",
    });
  });
});

describe("refreshTargets", () => {
  it("returns the root plus every visible loaded directory, parent-first", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/a"), dir("/repo/b")]);
    state = setChildren(state, "/repo/a", [dir("/repo/a/inner")]);
    state = toggleExpanded(state, "/repo/a"); // a is open + loaded
    // b is loaded=false (never fetched); a/inner is collapsed → skipped.
    expect(refreshTargets(state)).toEqual(["/repo", "/repo/a"]);
  });
});

describe("baseName", () => {
  it("takes the last segment, ignoring a trailing slash", () => {
    expect(baseName("/a/b/c")).toBe("c");
    expect(baseName("/a/b/c/")).toBe("c");
    expect(baseName("/")).toBe("");
  });
});
