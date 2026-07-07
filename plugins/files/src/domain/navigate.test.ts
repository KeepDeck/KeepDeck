import { describe, expect, it } from "vitest";
import type { FsEntry } from "@keepdeck/plugin-api";
import { baseName, initTree, setChildren, toggleExpanded } from "./tree";
import { navigate } from "./navigate";

const dir = (path: string): FsEntry => ({ name: baseName(path), path, kind: "dir" });
const file = (path: string): FsEntry => ({ name: baseName(path), path, kind: "file" });

/**
 * A tree:  src/ (expanded) → main.ts, util.ts ; readme.md
 * Visible rows: src, main.ts, util.ts, readme.md
 */
function sampleTree() {
  let state = initTree("/repo");
  state = setChildren(state, "/repo", [dir("/repo/src"), file("/repo/readme.md")]);
  state = setChildren(state, "/repo/src", [
    file("/repo/src/main.ts"),
    file("/repo/src/util.ts"),
  ]);
  state = toggleExpanded(state, "/repo/src");
  return state;
}

describe("navigate", () => {
  it("with no cursor, any arrow lands on the first row", () => {
    const state = sampleTree();
    for (const key of ["up", "down", "left", "right"] as const) {
      expect(navigate(state, null, key)).toEqual({ cursor: "/repo/src" });
    }
  });

  it("down moves to the next row and clamps at the last", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/src", "down").cursor).toBe("/repo/src/main.ts");
    expect(navigate(state, "/repo/readme.md", "down").cursor).toBe(
      "/repo/readme.md",
    );
  });

  it("up moves to the previous row and clamps at the first", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/src/main.ts", "up").cursor).toBe("/repo/src");
    expect(navigate(state, "/repo/src", "up").cursor).toBe("/repo/src");
  });

  it("right expands a collapsed directory without moving the cursor", () => {
    let state = initTree("/repo");
    state = setChildren(state, "/repo", [dir("/repo/src")]);
    // src is collapsed (never toggled).
    expect(navigate(state, "/repo/src", "right")).toEqual({
      cursor: "/repo/src",
      expand: "/repo/src",
    });
  });

  it("right steps into the first child of an expanded directory", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/src", "right").cursor).toBe("/repo/src/main.ts");
  });

  it("right on a file is a no-op", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/readme.md", "right")).toEqual({
      cursor: "/repo/readme.md",
    });
  });

  it("left collapses an expanded directory", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/src", "left")).toEqual({
      cursor: "/repo/src",
      collapse: "/repo/src",
    });
  });

  it("left jumps to the parent from a child row", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/src/util.ts", "left").cursor).toBe("/repo/src");
  });

  it("left on a top-level row (no parent) stays put", () => {
    const state = sampleTree();
    expect(navigate(state, "/repo/readme.md", "left").cursor).toBe(
      "/repo/readme.md",
    );
  });

  it("is a no-op on an empty tree", () => {
    const state = initTree("/repo");
    expect(navigate(state, null, "down")).toEqual({ cursor: null });
  });
});
