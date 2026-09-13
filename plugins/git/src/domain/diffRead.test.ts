import { describe, expect, it } from "vitest";
import { diffReadFor, fileAsDiff } from "./diffRead";
import { isEmptyDiff } from "./diff";
import type { ChangeRow } from "./status";

const row = (over: Partial<ChangeRow>): ChangeRow => ({
  path: "src/app.ts",
  origPath: null,
  code: "M",
  kind: "unstaged",
  ...over,
});

describe("diffReadFor", () => {
  it("a worktree row asks git for its section's diff, and nothing more", () => {
    expect(diffReadFor("/repo", row({ kind: "unstaged" }), undefined)).toEqual({
      source: "git",
      options: { staged: false },
    });
    expect(diffReadFor("/repo", row({ kind: "staged", code: "A" }), undefined)).toEqual({
      source: "git",
      options: { staged: true },
    });
  });

  it("a renamed row carries its old path so git pairs the rename with its edit", () => {
    const renamed = row({ kind: "staged", code: "R", path: "new.ts", origPath: "old.ts" });
    expect(diffReadFor("/repo", renamed, undefined)).toEqual({
      source: "git",
      options: { staged: true, origPath: "old.ts" },
    });
    // Across a range too — a commit's rename is still a rename.
    expect(diffReadFor("/repo", { ...renamed, kind: "history" }, { from: "a^", to: "a" })).toEqual({
      source: "git",
      options: { from: "a^", to: "a", origPath: "old.ts" },
    });
  });

  it("a history row diffs across its range; the open-ended sweep leaves `to` out", () => {
    expect(diffReadFor("/repo", row({ kind: "history" }), { from: "f0", to: "b2" })).toEqual({
      source: "git",
      options: { from: "f0", to: "b2" },
    });
    expect(diffReadFor("/repo", row({ kind: "history" }), { from: "f0" })).toEqual({
      source: "git",
      options: { from: "f0", to: undefined },
    });
  });

  it("untracked and unmerged rows read the working file, in any change set", () => {
    expect(diffReadFor("/repo", row({ kind: "untracked", code: "?", path: "notes.md" }), undefined)).toEqual({
      source: "file",
      path: "/repo/notes.md",
      as: "untracked",
    });
    // An untracked file inside a since-fork sweep has no diff at any range.
    expect(diffReadFor("/repo", row({ kind: "untracked", code: "?", path: "notes.md" }), { from: "f0" })).toEqual({
      source: "file",
      path: "/repo/notes.md",
      as: "untracked",
    });
    expect(diffReadFor("/repo", row({ kind: "conflicted", code: "UU" }), undefined)).toEqual({
      source: "file",
      path: "/repo/src/app.ts",
      as: "conflicted",
    });
  });

  it("joins the file's path with exactly one separator, whatever the repo ends in", () => {
    const untracked = row({ kind: "untracked", code: "?", path: "notes.md" });
    expect(diffReadFor("/repo/", untracked, undefined)).toMatchObject({ path: "/repo/notes.md" });
    expect(diffReadFor("/repo//", untracked, undefined)).toMatchObject({ path: "/repo/notes.md" });
    expect(diffReadFor("/", untracked, undefined)).toMatchObject({ path: "/notes.md" });
  });
});

describe("fileAsDiff", () => {
  const text = { text: "first\nsecond\n", isBinary: false, truncated: false };
  const binary = { text: null, isBinary: true, truncated: false };

  it("an untracked file is its content, all added, with nothing to note", () => {
    const diff = fileAsDiff("untracked", text);
    expect(diff.binary).toBe(false);
    expect(diff.notes).toEqual([]);
    expect(diff.hunks[0].lines.map((l) => [l.kind, l.text, l.newNo])).toEqual([
      ["add", "first", 1],
      ["add", "second", 2],
    ]);
  });

  it("an unmerged file is its content, markers included, under an unmerged note", () => {
    const diff = fileAsDiff("conflicted", {
      ...text,
      text: "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nc\n",
    });
    expect(diff.binary).toBe(false);
    expect(diff.notes).toEqual([{ kind: "unmerged" }]);
    // Every line keeps its exact text on the new side — nothing is read as
    // a marker column the way a combined diff would be.
    expect(diff.hunks[0].lines.map((l) => [l.kind, l.text, l.newNo])).toEqual([
      ["add", "a", 1],
      ["add", "<<<<<<< HEAD", 2],
      ["add", "ours", 3],
      ["add", "=======", 4],
      ["add", "theirs", 5],
      ["add", ">>>>>>> side", 6],
      ["add", "c", 7],
    ]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("a binary file has no text to show — and an unmerged one keeps its note", () => {
    expect(fileAsDiff("untracked", binary)).toEqual({
      binary: true,
      hunks: [],
      notes: [],
      truncated: false,
    });
    // The note is the one thing the peek can still say about it; dropping
    // it read as "binary file, nothing wrong" beside a Conflicts row.
    expect(fileAsDiff("conflicted", binary).notes).toEqual([{ kind: "unmerged" }]);
    expect(fileAsDiff("conflicted", binary).binary).toBe(true);
    // No text is binary too, whatever the flag says.
    expect(fileAsDiff("untracked", { ...binary, isBinary: false }).binary).toBe(true);
  });

  it("carries the read's truncation into the diff", () => {
    expect(fileAsDiff("untracked", { ...text, truncated: true }).truncated).toBe(true);
    expect(fileAsDiff("conflicted", { ...text, truncated: true }).truncated).toBe(true);
  });
});
