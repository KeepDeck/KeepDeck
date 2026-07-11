import { describe, expect, it } from "vitest";
import type { GitStatus, GitStatusEntry } from "@keepdeck/plugin-api";
import {
  baseName,
  codeLabel,
  dirName,
  groupEntries,
  headline,
} from "./status";

const entry = (over: Partial<GitStatusEntry>): GitStatusEntry => ({
  path: "file.ts",
  origPath: null,
  staged: ".",
  unstaged: ".",
  untracked: false,
  conflicted: false,
  ...over,
});

describe("groupEntries", () => {
  it("routes each entry to its section, keeping git's order within each", () => {
    const groups = groupEntries([
      entry({ path: "a.ts", unstaged: "M" }),
      entry({ path: "b.ts", staged: "A" }),
      entry({ path: "c.ts", untracked: true }),
      entry({ path: "d.ts", conflicted: true, staged: "U", unstaged: "U" }),
      entry({ path: "e.ts", unstaged: "D" }),
    ]);

    expect(groups.staged.map((r) => r.path)).toEqual(["b.ts"]);
    expect(groups.unstaged.map((r) => r.path)).toEqual(["a.ts", "e.ts"]);
    expect(groups.untracked.map((r) => r.path)).toEqual(["c.ts"]);
    expect(groups.conflicted.map((r) => r.path)).toEqual(["d.ts"]);
    expect(groups.total).toBe(5);
  });

  it("a path staged AND edited again appears in both sections — two different diffs", () => {
    const groups = groupEntries([
      entry({ path: "twice.ts", staged: "M", unstaged: "M" }),
    ]);

    expect(groups.staged).toHaveLength(1);
    expect(groups.unstaged).toHaveLength(1);
    expect(groups.staged[0].kind).toBe("staged");
    expect(groups.unstaged[0].kind).toBe("unstaged");
    // …but the badge counts distinct paths, not rows.
    expect(groups.total).toBe(1);
  });

  it("keeps the rename's old path on the row", () => {
    const groups = groupEntries([
      entry({ path: "new.ts", origPath: "old.ts", staged: "R" }),
    ]);
    expect(groups.staged[0].origPath).toBe("old.ts");
    expect(groups.staged[0].code).toBe("R");
  });

  it("a conflicted entry never leaks into staged/unstaged despite its codes", () => {
    const groups = groupEntries([
      entry({ path: "clash.ts", conflicted: true, staged: "D", unstaged: "U" }),
    ]);
    expect(groups.conflicted).toHaveLength(1);
    expect(groups.staged).toHaveLength(0);
    expect(groups.unstaged).toHaveLength(0);
  });
});

describe("codeLabel", () => {
  it("words the common porcelain codes and falls back for exotic ones", () => {
    expect(codeLabel("M")).toBe("modified");
    expect(codeLabel("A")).toBe("added");
    expect(codeLabel("D")).toBe("deleted");
    expect(codeLabel("R")).toBe("renamed");
    expect(codeLabel("?")).toBe("untracked");
    expect(codeLabel("U")).toBe("conflicted");
    expect(codeLabel("X")).toBe("changed");
  });
});

describe("headline", () => {
  const base: GitStatus = {
    branch: null,
    detached: false,
    oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    entries: [],
  };

  it("prefers the branch, then the detached short sha, then the unborn fallback", () => {
    expect(headline({ ...base, branch: "kd/app/1" })).toBe("kd/app/1");
    expect(
      headline({ ...base, detached: true, oid: "0123456789abcdef" }),
    ).toBe("0123456 (detached)");
    expect(headline(base)).toBe("(no commits yet)");
  });
});

describe("path split", () => {
  it("splits directory and file name, with root-level files having no dir", () => {
    expect(dirName("src/deep/file.ts")).toBe("src/deep/");
    expect(baseName("src/deep/file.ts")).toBe("file.ts");
    expect(dirName("file.ts")).toBe("");
    expect(baseName("file.ts")).toBe("file.ts");
  });
});
