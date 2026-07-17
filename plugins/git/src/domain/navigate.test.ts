import { describe, expect, it } from "vitest";
import { navigate } from "./navigate";
import type { ChangeRow } from "./status";

const row = (path: string, kind: ChangeRow["kind"] = "unstaged"): ChangeRow => ({
  path,
  origPath: null,
  code: "M",
  kind,
});

// Three directory groups in visual order: src/a, src/b, root.
const rows = [
  row("src/a/one.ts"),
  row("src/a/two.ts"),
  row("src/b/three.ts"),
  row("notes.md", "untracked"),
];

describe("navigate", () => {
  it("up and down step through files and clamp at the ends", () => {
    expect(navigate(rows, rows[0], "down")).toBe(rows[1]);
    expect(navigate(rows, rows[1], "up")).toBe(rows[0]);
    expect(navigate(rows, rows[0], "up")).toBeNull();
    expect(navigate(rows, rows[3], "down")).toBeNull();
  });

  it("right jumps to the next directory group's first file", () => {
    expect(navigate(rows, rows[0], "right")).toBe(rows[2]);
    expect(navigate(rows, rows[2], "right")).toBe(rows[3]);
    expect(navigate(rows, rows[3], "right")).toBeNull();
  });

  it("left jumps to the previous group's FIRST file, from anywhere in a group", () => {
    // From src/b, the previous group is src/a — its first row, not its last.
    expect(navigate(rows, rows[2], "left")).toBe(rows[0]);
    expect(navigate(rows, rows[3], "left")).toBe(rows[2]);
    expect(navigate(rows, rows[0], "left")).toBeNull();
  });

  it("the same path in two sections navigates by path AND kind", () => {
    const staged = row("src/a/one.ts", "staged");
    const twice = [staged, row("src/a/one.ts")];
    expect(navigate(twice, staged, "down")).toBe(twice[1]);
  });

  it("a vanished current row lands back on the first row", () => {
    expect(navigate(rows, row("gone.ts"), "down")).toBe(rows[0]);
    expect(navigate([], row("gone.ts"), "down")).toBeNull();
  });
});
