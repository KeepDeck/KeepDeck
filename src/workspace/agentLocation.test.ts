import { describe, expect, it } from "vitest";
import {
  canCreateAgent,
  classifyLocation,
  splitWorktreePath,
  type PathProbe,
} from "./agentLocation";

const probe = (p: Partial<PathProbe>): PathProbe => ({
  exists: false,
  isWorktree: false,
  branch: null,
  ...p,
});

describe("classifyLocation", () => {
  it("empty / whitespace path → main repo", () => {
    expect(classifyLocation("", null)).toBe("main");
    expect(classifyLocation("   ", probe({ exists: true }))).toBe("main");
  });

  it("path entered but not yet probed → checking", () => {
    expect(classifyLocation("/wt/a", null)).toBe("checking");
  });

  it("non-existent path → new worktree", () => {
    expect(classifyLocation("/wt/a", probe({ exists: false }))).toBe("new");
  });

  it("existing git worktree → existing (attach)", () => {
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: true })),
    ).toBe("existing");
  });

  it("existing non-worktree dir → blocked", () => {
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: false })),
    ).toBe("blocked");
  });
});

describe("canCreateAgent", () => {
  it("main and existing are always creatable", () => {
    expect(canCreateAgent("main", "")).toBe(true);
    expect(canCreateAgent("existing", "")).toBe(true);
  });

  it("a new worktree needs a non-blank branch", () => {
    expect(canCreateAgent("new", "")).toBe(false);
    expect(canCreateAgent("new", "   ")).toBe(false);
    expect(canCreateAgent("new", "kd/ws/1")).toBe(true);
  });

  it("checking and blocked can't be created", () => {
    expect(canCreateAgent("checking", "kd/ws/1")).toBe(false);
    expect(canCreateAgent("blocked", "kd/ws/1")).toBe(false);
  });
});

describe("splitWorktreePath", () => {
  it("splits a nested path into parent + leaf", () => {
    expect(splitWorktreePath("/a/b/c")).toEqual({ baseDir: "/a/b", dir: "c" });
  });

  it("keeps the root as the base for a top-level path", () => {
    expect(splitWorktreePath("/foo")).toEqual({ baseDir: "/", dir: "foo" });
  });

  it("ignores trailing slashes", () => {
    expect(splitWorktreePath("/a/b/")).toEqual({ baseDir: "/a", dir: "b" });
  });

  it("resolves a bare name against the current dir", () => {
    expect(splitWorktreePath("wt")).toEqual({ baseDir: ".", dir: "wt" });
  });
});
