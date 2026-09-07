import { describe, expect, it } from "vitest";
import {
  canCreateAgent,
  canStartFromSession,
  classifyLocation,
  forkTargetFor,
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
});

describe("what the deck says outranks the probe", () => {
  it("a directory a team WORKS in reads as an attach, whatever the disk says", () => {
    // The deck is the truer answer here: the team is the thing being joined,
    // and the disk may be lying — a worktree removed behind the app's back, or
    // a plain folder a `team.create` was pointed at. Asking the probe there is
    // how a path a team held came to be offered as a NEW worktree and then
    // refused on submit.
    expect(classifyLocation("/wt/a", probe({ exists: true, isWorktree: true }), "worked-in")).toBe(
      "existing",
    );
    expect(classifyLocation("/wt/a", probe({ exists: false }), "worked-in")).toBe("existing");
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: false, empty: true }), "worked-in"),
    ).toBe("existing");
    // Answered synchronously — no probe needed, and none waited for.
    expect(classifyLocation("/wt/a", null, "worked-in")).toBe("existing");
  });

  it("a directory a create is heading for is occupied for everyone", () => {
    expect(classifyLocation("/wt/a", null, "being-created")).toBe("occupied");
    expect(classifyLocation("/wt/a", probe({ exists: false }), "being-created")).toBe("occupied");
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: true }), "being-created"),
    ).toBe("occupied");
  });

  it("with the deck silent, the probe decides", () => {
    expect(classifyLocation("/wt/a", null, "free")).toBe("checking");
    expect(classifyLocation("/wt/a", probe({ exists: false }), "free")).toBe("new");
    expect(classifyLocation("/wt/a", probe({ exists: true, isWorktree: true }), "free")).toBe(
      "existing",
    );
    expect(
      classifyLocation("/wt/a", probe({ exists: true, isWorktree: false, empty: false }), "free"),
    ).toBe("blocked");
  });

  it("an empty path stays main — the workspace root is a directory like any other", () => {
    expect(classifyLocation("", null, "worked-in")).toBe("main");
    expect(classifyLocation("", null, "being-created")).toBe("main");
  });

  it("an occupied path can never be created", () => {
    expect(canCreateAgent("occupied", "some-branch")).toBe(false);
  });
});

describe("canStartFromSession", () => {
  it("a fresh session always passes — the picker doesn't apply", () => {
    expect(canStartFromSession("new", false, null)).toBe(true);
    // Leftover pick state from a mode the user backed out of is inert.
    expect(canStartFromSession("new", true, "claimed")).toBe(true);
  });

  it("continuing needs a picked session", () => {
    expect(canStartFromSession("resume", false, null)).toBe(false);
    expect(canStartFromSession("fork", false, null)).toBe(false);
  });

  it("resume additionally needs a resumable pick; fork is the escape hatch", () => {
    expect(canStartFromSession("resume", true, null)).toBe(true);
    expect(canStartFromSession("resume", true, "dir-gone")).toBe(false);
    expect(canStartFromSession("resume", true, "no-cwd")).toBe(false);
    expect(canStartFromSession("resume", true, "claimed")).toBe(false);
    // The exact sessions resume refuses are the ones fork exists for.
    expect(canStartFromSession("fork", true, "dir-gone")).toBe(true);
    expect(canStartFromSession("fork", true, "claimed")).toBe(true);
  });
});

describe("forkTargetFor", () => {
  it("provisions a new worktree at the chosen path and branch", () => {
    expect(
      forkTargetFor({ kind: "new", path: "/wt/a", branch: "fork/a" }, "/repo"),
    ).toEqual({ kind: "worktree", path: "/wt/a", branch: "fork/a" });
  });

  it("carries the picked base branch — losing it forks from a moving HEAD", () => {
    // The two dialogs had their own copy of this mapping and only one of them
    // passed the base, so the same gesture cut from a different commit
    // depending on which surface the user reached it from.
    expect(
      forkTargetFor(
        { kind: "new", path: "/wt/a", branch: "fork/a", baseBranch: "release" },
        "/repo",
      ),
    ).toEqual({
      kind: "worktree",
      path: "/wt/a",
      branch: "fork/a",
      base: "release",
    });
  });

  it("keeps an empty base off the target rather than passing a blank", () => {
    expect(
      forkTargetFor(
        { kind: "new", path: "/wt/a", branch: "fork/a", baseBranch: "" },
        "/repo",
      ),
    ).toEqual({ kind: "worktree", path: "/wt/a", branch: "fork/a" });
  });

  it("lands in an existing folder as-is, with no git mutation", () => {
    expect(
      forkTargetFor({ kind: "existing", path: "/wt/b", branch: "kd/b" }, "/repo"),
    ).toEqual({ kind: "dir", cwd: "/wt/b" });
  });

  it("reads the main choice as the workspace's own folder", () => {
    expect(forkTargetFor({ kind: "main" }, "/repo")).toEqual({
      kind: "dir",
      cwd: "/repo",
    });
  });
});
