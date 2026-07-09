import { describe, expect, it } from "vitest";
import {
  canCreateAgent,
  classifyLocation,
  isKnownBaseBranch,
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

  it("an unusable base blocks only a NEW worktree — main/existing never fork", () => {
    expect(canCreateAgent("new", "kd/ws/1", false)).toBe(false);
    expect(canCreateAgent("new", "kd/ws/1", true)).toBe(true);
    // A stale base left in dialog state must not veto locations without one.
    expect(canCreateAgent("main", "", false)).toBe(true);
    expect(canCreateAgent("existing", "", false)).toBe(true);
  });
})

describe("isKnownBaseBranch", () => {
  const branches = ["develop", "main"];

  it("empty input defers to HEAD — always fine", () => {
    expect(isKnownBaseBranch("", branches)).toBe(true);
    expect(isKnownBaseBranch("   ", branches)).toBe(true);
  });

  it("accepts exactly a listed local branch, trimmed", () => {
    expect(isKnownBaseBranch("develop", branches)).toBe(true);
    expect(isKnownBaseBranch(" develop ", branches)).toBe(true);
    expect(isKnownBaseBranch("dev", branches)).toBe(false);
    expect(isKnownBaseBranch("origin/main", branches)).toBe(false);
  });

  it("a missing list validates everything — degrade, don't block the dialog", () => {
    expect(isKnownBaseBranch("anything", null)).toBe(true);
  });
});;

describe("occupied locations", () => {
  it("an occupied path outranks every probe outcome, even mid-probe", () => {
    expect(classifyLocation("/wt/a", null, "worktree")).toBe("occupied");
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: true }), "worktree"),
    ).toBe("occupied");
    expect(classifyLocation("/wt/a", probe({ exists: false }), "provisioning")).toBe(
      "occupied",
    );
  });

  it("an empty path stays main — bare panes legitimately share the workspace cwd", () => {
    expect(classifyLocation("", null, "worktree")).toBe("main");
  });

  it("an occupied path can never be created", () => {
    expect(canCreateAgent("occupied", "some-branch")).toBe(false);
  });

  it("attach-anyway turns worktree occupancy into a plain attach — instantly, no probe needed", () => {
    // The occupancy itself proves the dir is a worktree (a pane runs in it):
    // the override applies even while the probe is still in flight.
    expect(classifyLocation("/wt/a", null, "worktree", true)).toBe("existing");
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: true }), "worktree", true),
    ).toBe("existing");
  });

  it("attach-anyway never applies to a provisioning target — nothing exists to attach to", () => {
    expect(classifyLocation("/wt/a", null, "provisioning", true)).toBe("occupied");
    expect(
      classifyLocation("/wt/a", probe({ exists: false }), "provisioning", true),
    ).toBe("occupied");
  });
});
