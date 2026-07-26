import { describe, expect, it } from "vitest";
import { diffKey } from "./peek";
import { commitRange } from "./history";
import type { ChangeRow } from "./status";

const row = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  path: "src/app.ts",
  origPath: null,
  code: "M",
  kind: "unstaged",
  ...over,
});

describe("diffKey", () => {
  it("the same file read the same way is the same diff", () => {
    // Fresh row objects: identity is the VALUES, not the reference — the
    // status feed rebuilds these rows on every refresh.
    expect(diffKey("/repo", row(), undefined)).toBe(
      diffKey("/repo", row(), undefined),
    );
  });

  it("the range is part of it — one path at two commits is two diffs", () => {
    // The motivating case: both render the same name and the same header, so
    // nothing about how they DISPLAY tells them apart.
    const historyRow = row({ kind: "history" });
    expect(diffKey("/repo", historyRow, commitRange("aaa1111"))).not.toBe(
      diffKey("/repo", historyRow, commitRange("bbb2222")),
    );
  });

  it("the repo is part of it — the same path in another worktree is another file", () => {
    expect(diffKey("/repo", row(), undefined)).not.toBe(
      diffKey("/wt/one", row(), undefined),
    );
  });

  it("the row kind is part of it — staged and unstaged are different diffs", () => {
    // Not cosmetic: the kind picks which diff git is asked for.
    expect(diffKey("/repo", row({ kind: "staged" }), undefined)).not.toBe(
      diffKey("/repo", row({ kind: "unstaged" }), undefined),
    );
  });

  it("no file chosen yet keys apart from every real file", () => {
    const range = commitRange("aaa1111");
    expect(diffKey("/repo", null, range)).not.toBe(
      diffKey("/repo", row({ kind: "history" }), range),
    );
  });

  it("fields cannot spell out each other's key", () => {
    // Under a printable separator these two would both join to
    // "/repo:unstaged:a:b::" — the NUL join keeps them distinct.
    expect(diffKey("/repo:unstaged", row({ path: "a:b" }), undefined)).not.toBe(
      diffKey("/repo", row({ path: "unstaged:a:b" }), undefined),
    );
  });
});
