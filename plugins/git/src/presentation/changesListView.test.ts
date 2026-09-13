import { describe, expect, it } from "vitest";
import { changesItemEstimate, changesItemKey, changesList } from "./changesListView";
import { groupEntries } from "../domain/status";
import type { GitStatusEntry } from "@keepdeck/plugin-api";

const entry = (over: Partial<GitStatusEntry>): GitStatusEntry => ({
  path: "file.ts",
  origPath: null,
  staged: ".",
  unstaged: ".",
  untracked: false,
  conflicted: false,
  ...over,
});

describe("changesList", () => {
  it("lists each section that has rows as a head and its rows, in the tab's order", () => {
    const groups = groupEntries([
      entry({ path: "a.ts", unstaged: "M" }),
      entry({ path: "n.md", untracked: true }),
      entry({ path: "c.ts", conflicted: true, staged: "U", unstaged: "U" }),
    ]);
    const items = changesList(groups);
    expect(items.map((i) => (i.kind === "head" ? `#${i.label}(${i.count})` : i.row.path))).toEqual([
      "#Conflicts(1)",
      "c.ts",
      "#Changes(1)",
      "a.ts",
      "#Untracked(1)",
      "n.md",
    ]);
    // Only the first head opens the list; the others follow a section.
    expect(items.filter((i) => i.kind === "head").map((i) => i.first)).toEqual([true, false, false]);
  });

  it("leaves out a section with nothing in it", () => {
    const items = changesList(groupEntries([entry({ path: "a.ts", staged: "A" })]));
    expect(items.map((i) => i.key)).toEqual(["head:Staged", "staged:a.ts"]);
  });

  it("keys a path by its section too — staged and edited again are two rows", () => {
    const items = changesList(groupEntries([entry({ path: "twice.ts", staged: "M", unstaged: "M" })]));
    expect(items.filter((i) => i.kind === "row").map((i) => i.key)).toEqual([
      "staged:twice.ts",
      "unstaged:twice.ts",
    ]);
  });

  it("an empty status is an empty list", () => {
    expect(changesList(groupEntries([]))).toEqual([]);
  });

  it("guesses a head that follows a section taller than a row, by the gap it carries", () => {
    const items = changesList(
      groupEntries([entry({ path: "a.ts", staged: "A" }), entry({ path: "b.ts", unstaged: "M" })]),
    );
    expect(items.map(changesItemEstimate)).toEqual([24, 24, 32, 24]);
    expect(items.map(changesItemKey)).toEqual(items.map((i) => i.key));
  });
});
