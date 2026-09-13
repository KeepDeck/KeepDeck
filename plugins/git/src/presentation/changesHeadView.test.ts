import { describe, expect, it } from "vitest";
import type { GitStatus } from "@keepdeck/plugin-api";
import { changesHead } from "./changesHeadView";

const status = (over: Partial<GitStatus>): GitStatus => ({
  branch: "main",
  detached: false,
  oid: "abc",
  upstream: null,
  ahead: null,
  behind: null,
  entries: [],
  ...over,
});
const groups = (total: number) => ({
  conflicted: [],
  staged: [],
  unstaged: [],
  untracked: [],
  total,
});

describe("changesHead", () => {
  it("counts the changed paths, null before the first status", () => {
    expect(changesHead(null, null).count).toBeNull();
    expect(changesHead(status({}), groups(4)).count).toBe(4);
  });

  it("shows the upstream only when the branch stands somewhere against it", () => {
    expect(changesHead(status({}), groups(0)).upstream).toBeNull();
    // An upstream the branch is level with is not worth a badge.
    expect(
      changesHead(status({ upstream: "origin/main", ahead: 0, behind: 0 }), groups(0)).upstream,
    ).toBeNull();
    expect(
      changesHead(status({ upstream: "origin/main", ahead: 2, behind: 1 }), groups(0)).upstream,
    ).toEqual({ name: "origin/main", ahead: 2, behind: 1 });
    expect(
      changesHead(status({ upstream: "origin/main", ahead: 0, behind: 3 }), groups(0)).upstream,
    ).toEqual({ name: "origin/main", ahead: 0, behind: 3 });
  });
});
