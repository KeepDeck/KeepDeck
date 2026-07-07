import { describe, expect, it } from "vitest";
import type { FsEntry } from "@keepdeck/plugin-api";
import { sortEntries } from "./entries";

const entry = (name: string, kind: FsEntry["kind"]): FsEntry => ({
  name,
  path: `/root/${name}`,
  kind,
});

describe("sortEntries", () => {
  it("puts directories ahead of files and symlinks", () => {
    const sorted = sortEntries([
      entry("readme.md", "file"),
      entry("src", "dir"),
      entry("link", "symlink"),
      entry("assets", "dir"),
    ]);
    expect(sorted.map((e) => e.name)).toEqual([
      "assets",
      "src",
      "link",
      "readme.md",
    ]);
  });

  it("sorts within a group case-insensitively", () => {
    const sorted = sortEntries([
      entry("Zebra.ts", "file"),
      entry("apple.ts", "file"),
      entry("Banana.ts", "file"),
    ]);
    expect(sorted.map((e) => e.name)).toEqual([
      "apple.ts",
      "Banana.ts",
      "Zebra.ts",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [entry("b", "file"), entry("a", "dir")];
    const snapshot = input.map((e) => e.name);
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(snapshot);
  });

  it("is a no-op shape for an empty listing", () => {
    expect(sortEntries([])).toEqual([]);
  });
});
