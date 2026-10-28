import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  armDoubles,
  cwdArming,
  managerFor,
  provisionRequests,
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

describe("the ordering between plantings and teardown", () => {
  // The race this manager was built for: a planting lands in a pane's cwd, and
  // a removal deletes that directory. One landing inside the other leaves a
  // husk git can no longer even name. Staging rides the same queue, so it
  // never rebuilds what a sweep in flight is pruning.
  beforeEach(() => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
  });
  it("disarms before git on the ROLLBACK path too, not only on a close", async () => {
    // The rollback used to call `removeWorktree` directly — off the queue and
    // with no disarm — so the owner had two teardowns with two guarantees.
    const order: string[] = [];
    cwdArming.cwdDisarm.mockImplementation(async (roots) => {
      order.push(`disarm:${roots.join(",")}`);
      return [...roots];
    });
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/team-1",
      branch: "kd/ws/1",
    });
    worktree.removeWorktree.mockImplementation(async (_repo, path) => {
      order.push(`remove:${path}`);
    });
    manager.registerPostProvision("team-1", async () => {
      throw new Error("surgery boom");
    });

    await manager.provision(
      provisionRequests(1),
      "ws",
      { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays },
    );

    expect(order).toEqual(["disarm:/wt/team-1", "remove:/wt/team-1"]);
  });

  it("keeps a root a live workspace still claims armed, and in place", async () => {
    // Two workspaces may share a spawn cwd, and the arming is keyed by path.
    // Disarming on one workspace's behalf would strip the other's link — and
    // deleting the directory would pull it out from under the other's panes.
    deck = [{ id: "ws-2", roots: ["/wt/shared"] }];

    const failures = await manager.remove([{ repo: "/r", path: "/wt/shared", branch: "b" }]);

    expect(cwdArming.cwdDisarm).toHaveBeenCalledWith(["/wt/shared"], ["/wt/shared"]);
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
    expect(failures).toEqual(["b: another workspace still works in this folder"]);
  });

  it("still removes the worktree when the disarm itself failed", async () => {
    // A failed pass says nothing about who claims the folder; the removal the
    // user asked for goes ahead, as it always did.
    cwdArming.cwdDisarm.mockResolvedValue(null);

    await manager.remove([{ repo: "/r", path: "/wt/1", branch: "b" }]);

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
    // The close hands the folder straight back: the "+ Team" dialog suggests a
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
      provisionRequests(1),
      "ws",
      { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays },
    );
    release();
    await Promise.all([removing, provisioning]);

    expect(order).toEqual(["remove", "create"]);
  });

  it("takes its own hooks out of a directory before git touches it", async () => {
    const order: string[] = [];
    cwdArming.cwdDisarm.mockImplementation(async (roots) => {
      order.push(`disarm:${roots.join(",")}`);
      return [...roots];
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
