import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@keepdeck/plugin-api";
import { changeSetRows, seedRow, type ChangeSet } from "./changeSet";
import type { ChangeGroups, ChangeRow } from "./status";

const row = (path: string, kind: ChangeRow["kind"]): ChangeRow => ({
  path,
  origPath: null,
  code: "M",
  kind,
});

const groups: ChangeGroups = {
  conflicted: [row("c.ts", "conflicted")],
  staged: [row("s.ts", "staged")],
  unstaged: [row("u.ts", "unstaged")],
  untracked: [row("n.md", "untracked")],
  total: 4,
};

const files: GitChangedFile[] = [
  { path: "src/a.ts", origPath: null, code: "M" },
  { path: "src/b.ts", origPath: "src/old.ts", code: "R" },
];

const fork: ChangeSet = { kind: "history", scope: { kind: "fork", forkSha: "f0".repeat(20) } };

describe("changeSetRows", () => {
  it("a worktree set walks the sections in their order: conflicts, staged, changes, untracked", () => {
    const rows = changeSetRows({ kind: "worktree", groups, error: null }, null);
    expect(rows.map((r) => r.path)).toEqual(["c.ts", "s.ts", "u.ts", "n.md"]);
  });

  it("a worktree set has no rows until its status has loaded", () => {
    expect(changeSetRows({ kind: "worktree", groups: null, error: null }, files)).toEqual([]);
  });

  it("a History set lists its files as peek rows, none until they have loaded", () => {
    expect(changeSetRows(fork, files)).toEqual([
      { path: "src/a.ts", origPath: null, code: "M", kind: "history" },
      { path: "src/b.ts", origPath: "src/old.ts", code: "R", kind: "history" },
    ]);
    expect(changeSetRows(fork, null)).toEqual([]);
  });
});

describe("seedRow", () => {
  it("a History scope opens on its first file once the files have landed", () => {
    expect(seedRow("history", null, files)).toEqual({
      path: "src/a.ts",
      origPath: null,
      code: "M",
      kind: "history",
    });
  });

  it("does not seed before the files land, nor when there are none", () => {
    expect(seedRow("history", null, null)).toBeNull();
    expect(seedRow("history", null, [])).toBeNull();
  });

  it("never seeds over a chosen row, and never for a worktree diff", () => {
    expect(seedRow("history", row("src/b.ts", "history"), files)).toBeNull();
    expect(seedRow("worktree", null, files)).toBeNull();
  });
});
