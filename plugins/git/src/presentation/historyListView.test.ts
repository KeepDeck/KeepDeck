import { describe, expect, it } from "vitest";
import type { GitHistory } from "@keepdeck/plugin-api";
import { historyCount, historyList } from "./historyListView";

const NOW = 1_760_000_000_000;
const fork = "f0".repeat(20);
const commit = (sha: string, subject: string, ago: number) => ({
  sha,
  author: "Me",
  timestamp: NOW / 1000 - ago,
  subject,
});

describe("historyCount", () => {
  it("counts the branch's own commits, and nothing without a fork or a log", () => {
    expect(historyCount({ forkSha: fork, ahead: 3, commits: [] })).toBe(3);
    expect(historyCount({ forkSha: fork, ahead: 0, commits: [] })).toBe(0);
    expect(historyCount({ forkSha: null, ahead: null, commits: [] })).toBeNull();
    expect(historyCount(null)).toBeNull();
  });
});

describe("historyList", () => {
  it("pins the since-fork sweep, then the log with the boundary drawn at the fork commit", () => {
    const history: GitHistory = {
      forkSha: fork,
      ahead: 2,
      commits: [
        commit("a1".repeat(20), "add feature", 60),
        commit("b2".repeat(20), "fix tests", 3600),
        commit(fork, "base work", 86_400),
        commit("e5".repeat(20), "older base work", 172_800),
      ],
    };
    const { rows, empty } = historyList(history, NOW);
    expect(empty).toBe(false);
    expect(rows.map((r) => r.kind)).toEqual(["pin", "commit", "commit", "fork", "commit", "commit"]);
    expect(rows[0]).toEqual({
      kind: "pin",
      count: "2 commits",
      hint: `Everything since ${fork.slice(0, 7)}, working tree included`,
      scope: { kind: "fork", forkSha: fork },
    });
    expect(rows[1]).toEqual({
      kind: "commit",
      sha: "a1".repeat(20),
      short: "a1a1a1a",
      subject: "add feature",
      when: "1m",
      hint: "add feature — Me",
      scope: { kind: "commit", sha: "a1".repeat(20), subject: "add feature" },
    });
    // The divider sits right before the fork commit itself.
    expect(rows[4]).toMatchObject({ kind: "commit", subject: "base work" });
  });

  it("counts the branch's own side of the fork in words, one commit singular", () => {
    const history: GitHistory = { forkSha: fork, ahead: 1, commits: [] };
    expect(historyList(history, NOW).rows[0]).toMatchObject({ count: "1 commit" });
    expect(historyList({ ...history, ahead: null }, NOW).rows[0]).toMatchObject({
      count: "0 commits",
    });
  });

  it("without a fork point it is a plain log: no pin, no divider", () => {
    const history: GitHistory = {
      forkSha: null,
      ahead: null,
      commits: [commit("d4".repeat(20), "init", 10)],
    };
    const { rows } = historyList(history, NOW);
    expect(rows.map((r) => r.kind)).toEqual(["commit"]);
  });

  it("a fork commit outside the loaded window draws no divider yet", () => {
    const history: GitHistory = {
      forkSha: fork,
      ahead: 5,
      commits: [commit("a1".repeat(20), "add feature", 60)],
    };
    expect(historyList(history, NOW).rows.map((r) => r.kind)).toEqual(["pin", "commit"]);
  });

  it("an empty log says so, fork or not", () => {
    expect(historyList({ forkSha: null, ahead: null, commits: [] }, NOW)).toEqual({
      rows: [],
      empty: true,
    });
    expect(historyList({ forkSha: fork, ahead: 0, commits: [] }, NOW).empty).toBe(true);
  });
});
