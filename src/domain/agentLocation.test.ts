import { describe, expect, it } from "vitest";
import {
  canCreateAgent,
  classifyLocation,
  type PathProbe,
} from "./agentLocation";

const probe = (p: Partial<PathProbe>): PathProbe => ({
  exists: false,
  isWorktree: false,
  empty: false,
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

  it("existing EMPTY non-worktree dir → new (create into it)", () => {
    expect(
      classifyLocation(
        "/wt/a",
        probe({ exists: true, isWorktree: false, empty: true }),
      ),
    ).toBe("new");
  });

  it("existing NON-EMPTY non-worktree dir → blocked", () => {
    expect(
      classifyLocation(
        "/wt/a",
        probe({ exists: true, isWorktree: false, empty: false }),
      ),
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

describe("occupied locations", () => {
  it("an occupied path outranks every probe outcome, even mid-probe", () => {
    expect(classifyLocation("/wt/a", null, true)).toBe("occupied");
    expect(classifyLocation("/wt/a", probe({ exists: true, isWorktree: true }), true)).toBe(
      "occupied",
    );
    expect(classifyLocation("/wt/a", probe({ exists: true }), true)).toBe("occupied");
  });

  it("an empty path stays main — bare panes legitimately share the workspace cwd", () => {
    expect(classifyLocation("", null, true)).toBe("main");
  });

  it("an occupied path can never be created", () => {
    expect(canCreateAgent("occupied", "some-branch")).toBe(false);
  });
});
