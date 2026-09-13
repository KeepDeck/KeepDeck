import { describe, expect, it } from "vitest";
import {
  commitRange,
  historyRow,
  readVersionFor,
  relativeTime,
  scopeIsPinned,
  scopeLabel,
  scopeRange,
  scopeSha,
  shortSha,
  sinceForkRange,
  type HistoryScope,
} from "./history";

describe("ranges", () => {
  it("a commit's range runs parent-to-itself; since-fork stays open-ended", () => {
    expect(commitRange("abc123")).toEqual({ from: "abc123^", to: "abc123" });
    // No `to`: the diff reaches the WORKING TREE, so uncommitted work counts.
    expect(sinceForkRange("fork456")).toEqual({ from: "fork456" });
  });
});

describe("scopes", () => {
  const commit: HistoryScope = {
    kind: "commit",
    sha: "abc123",
    subject: "add feature",
  };
  const fork: HistoryScope = { kind: "fork", forkSha: "fork456" };

  it("a commit scope diffs parent-to-itself and names its subject and sha", () => {
    expect(scopeRange(commit)).toEqual({ from: "abc123^", to: "abc123" });
    expect(scopeLabel(commit)).toBe("add feature");
    expect(scopeSha(commit)).toBe("abc123");
  });

  it("only a commit scope is pinned — a fork sweep follows the tree or a branch", () => {
    expect(scopeIsPinned(commit)).toBe(true);
    expect(scopeIsPinned(fork)).toBe(false);
    // A branch name can move under the peek, so a rev-pinned sweep is live too.
    expect(scopeIsPinned({ ...fork, rev: "kd/side/1" })).toBe(false);
  });

  it("a pinned scope reads on a frozen revision until the feed fails", () => {
    const healthy = { version: 7, error: null };
    expect(readVersionFor(commit, healthy)).toBe(0);
    expect(readVersionFor(fork, healthy)).toBe(7);
    expect(readVersionFor(null, healthy)).toBe(7);
    // The repo may be gone: even a commit's peek must go and find out.
    expect(readVersionFor(commit, { version: 8, error: "no such path" })).toBe(8);
  });

  it("a fork scope reaches the working tree on the checkout, the ref when pinned", () => {
    expect(scopeRange(fork)).toEqual({ from: "fork456" });
    expect(scopeRange({ ...fork, rev: "kd/side/1" })).toEqual({
      from: "fork456",
      to: "kd/side/1",
    });
    expect(scopeLabel(fork)).toBe("Since fork");
    expect(scopeSha(fork)).toBe("fork456");
  });
});

describe("shortSha", () => {
  it("abbreviates to git's seven", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0); // 2026-07-12T12:00Z
  const at = (secondsAgo: number) => Math.floor(now / 1000) - secondsAgo;

  it("steps through now/minutes/hours/days and lands on a date", () => {
    expect(relativeTime(at(5), now)).toBe("now");
    expect(relativeTime(at(90), now)).toBe("1m");
    expect(relativeTime(at(59 * 60), now)).toBe("59m");
    expect(relativeTime(at(3 * 3600), now)).toBe("3h");
    expect(relativeTime(at(2 * 86400), now)).toBe("2d");
    expect(relativeTime(at(45 * 86400), now)).toMatch(/May \d+/);
  });

  it("a clock skewed into the future reads as now, not negative", () => {
    expect(relativeTime(at(-120), now)).toBe("now");
  });
});

describe("historyRow", () => {
  it("maps a changed file to a history-kind peek row", () => {
    expect(
      historyRow({ path: "src/new.ts", origPath: "src/old.ts", code: "R" }),
    ).toEqual({
      path: "src/new.ts",
      origPath: "src/old.ts",
      code: "R",
      kind: "history",
    });
  });

  it("maps an untracked file of a working-tree range to an untracked row", () => {
    // `?` is listed only when the range reaches the working tree; there is
    // no diff to read for it at any range, so the row is the file itself —
    // the same shape an untracked status entry makes.
    expect(historyRow({ path: "scratch.md", origPath: null, code: "?" })).toEqual({
      path: "scratch.md",
      origPath: null,
      code: "?",
      kind: "untracked",
    });
  });
});
