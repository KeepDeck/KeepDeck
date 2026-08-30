import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  armDoubles,
  managerFor,
  provisioningCards,
  ref,
  skills,
  stagedFor,
  worktree,
  type DeckEntry,
  type WorktreeManager,
} from "./testSupport";

/** The pane is still in the deck for the whole create — the ordinary case.
 * The tests that close a pane mid-create override this. */
const stays = () => false;

let deck: DeckEntry[] = [];
let manager: WorktreeManager;

beforeEach(() => {
  vi.resetAllMocks();
  deck = [];
  armDoubles();
  manager = managerFor(() => deck);
});

describe("the ordering between arming and teardown", () => {
  // The race this manager was built for: staging arms every live root with a
  // `.agents/skills` symlink, and a removal deletes a root's directory. One
  // landing inside the other leaves a husk git can no longer even name.
  //
  // A live workspace throughout: the armings below are the ones a real spawn
  // performs, and a workspace the deck has dropped deliberately stages nothing.
  beforeEach(() => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
  });
  it("disarms before git on the ROLLBACK path too, not only on a close", async () => {
    // The rollback used to call `removeWorktree` directly — off the queue and
    // with no disarm — so the owner had two teardowns with two guarantees.
    const order: string[] = [];
    skills.disarmSkills.mockImplementation(async (roots) => {
      order.push(`disarm:${roots.join(",")}`);
      return true;
    });
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/pane-1",
      branch: "kd/ws/1",
    });
    worktree.removeWorktree.mockImplementation(async (_repo, path) => {
      order.push(`remove:${path}`);
    });
    manager.registerPostProvision("pane-1", async () => {
      throw new Error("surgery boom");
    });

    await manager.provision(
      provisioningCards(1),
      { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays },
    );

    expect(order).toEqual(["disarm:/wt/pane-1", "remove:/wt/pane-1"]);
  });

  it("keeps a root a live workspace still claims armed, even while deleting it", async () => {
    // Two workspaces may share a spawn cwd, and the arming is keyed by path.
    // Disarming on one workspace's behalf would strip the other's link.
    deck = [{ id: "ws-2", roots: ["/wt/shared"] }];

    await manager.remove([{ repo: "/r", path: "/wt/shared", branch: "b" }]);

    expect(skills.disarmSkills).toHaveBeenCalledWith([]);
    expect(worktree.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("takes one queue slot per target, so an unrelated spawn is not stalled", async () => {
    // A workspace closing six panes used to hold the single slot for the whole
    // loop, parking every other workspace's plan build behind N git removals.
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let removals = 0;
    worktree.removeWorktree.mockImplementation(async () => {
      removals += 1;
      if (removals === 1) await firstHeld;
    });

    const removing = manager.remove([
      { repo: "/r", path: "/wt/1", branch: "b1" },
      { repo: "/r", path: "/wt/2", branch: "b2" },
    ]);
    const arming = manager.skillsFor(ref("ws-1"));
    releaseFirst();
    await removing;
    await arming;

    // The staging ran between the two removals rather than after both.
    const stagedAfter = skills.stageSkills.mock.invocationCallOrder[0];
    const lastRemoval = worktree.removeWorktree.mock.invocationCallOrder[1];
    expect(stagedAfter).toBeLessThan(lastRemoval);
  });

  it("makes a create wait for a queued teardown of the same directory", async () => {
    // The close hands the folder straight back: the "+ Agent" dialog suggests a
    // path whose teardown is still queued, because the pane has already left the
    // deck and nothing reads it as occupied. Unqueued, the create could land
    // first and git would then delete a live worktree.
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => {
      order.push("remove");
      await held;
    });
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockImplementation(async () => {
      order.push("create");
      return { path: "/wt/pane-1", branch: "kd/ws/1" };
    });

    const removing = manager.remove([
      { repo: "/repo", path: "/wt/pane-1", branch: "old" },
    ]);
    const provisioning = manager.provision(
      provisioningCards(1),
      { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays },
    );
    release();
    await Promise.all([removing, provisioning]);

    expect(order).toEqual(["remove", "create"]);
  });

  it("takes its own hooks out of a directory before git touches it", async () => {
    const order: string[] = [];
    skills.disarmSkills.mockImplementation(async (roots) => {
      order.push(`disarm:${roots.join(",")}`);
      return true;
    });
    worktree.removeWorktree.mockImplementation(async (_repo, path) => {
      order.push(`remove:${path}`);
    });

    await manager.remove([{ repo: "/r", path: "/wt/1", branch: "b1" }]);

    expect(order).toEqual(["disarm:/wt/1", "remove:/wt/1"]);
  });

  it("holds an arming until the removal in flight has finished", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => held);

    const removing = manager.remove([{ repo: "/r", path: "/wt/1", branch: "b1" }]);
    const arming = manager.skillsFor(ref("ws-1"));
    // Give the staging every chance to jump the queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(skills.stageSkills).not.toHaveBeenCalled();

    release();
    await removing;
    await arming;
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);
  });

  it("re-arms a root that left and came back — the memo must not outlive it", async () => {
    // Deleting a pane frees its folder, and the next "+ Agent" takes the same
    // one back. The memo caches the RESULT of the call that armed it, so unless
    // a teardown forgets that entry the returning worktree hits the cache and
    // `stageSkills` — the only code that arms — never runs for it again.
    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }];
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);

    await manager.remove([{ repo: "/r", path: "/wt/b", branch: "b" }]);
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.skillsFor(ref("ws-1"));

    // The freed folder is taken again by a new pane: same roots, same key.
    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }];
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a", "/wt/b"]);
    expect(skills.stageSkills).toHaveBeenCalledTimes(3);
  });

  it("forgets the stagings a SWEEP disarmed, not only a removal's", async () => {
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.sweep(true); // establishes the baseline
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);

    deck = [{ id: "ws-1", roots: [] }]; // the pane closed, no delete asked for
    await manager.sweep(true);
    expect(skills.disarmSkills).toHaveBeenLastCalledWith(["/wt/a"]);

    deck = [{ id: "ws-1", roots: ["/wt/a"] }]; // and a new pane lands there
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("a failed removal does not stall what is queued behind it", async () => {
    worktree.removeWorktree.mockRejectedValue(new Error("dirty"));

    const failures = await manager.remove([
      { repo: "/r", path: "/wt/1", branch: "b1" },
    ]);
    expect(failures).toHaveLength(1);

    await expect(manager.skillsFor(ref("ws-1"))).resolves.toEqual(
      stagedFor("ws-1"),
    );
  });
});

describe("remove", () => {
  it("keeps tearing down after a failure and collects its message", async () => {
    worktree.removeWorktree
      .mockRejectedValueOnce(new Error("dirty"))
      .mockResolvedValueOnce(undefined);
    const failures = await manager.remove([
      { repo: "/r", path: "/wt/1", branch: "b1" },
      { repo: "/r", path: "/wt/2", branch: "b2" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("b1");
    expect(worktree.removeWorktree).toHaveBeenCalledTimes(2);
    // The delete checkbox's intent covers the agent's created side branches.
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/r", "/wt/2", {
      force: true,
      branch: "b2",
      reapCreatedBranches: true,
    });
  });
});
