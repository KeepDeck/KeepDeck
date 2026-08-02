import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  armDoubles,
  managerFor,
  mcpArming,
  ref,
  skills,
  stagedFor,
  worktree,
  type DeckEntry,
  type WorktreeManager,
} from "./testSupport";

let deck: DeckEntry[] = [];
let manager: WorktreeManager;

beforeEach(() => {
  vi.resetAllMocks();
  deck = [];
  armDoubles();
  manager = managerFor(() => deck);
});

describe("skillsFor", () => {
  // A workspace the deck still has. Staging for one it does NOT have is a case
  // of its own ("no staging for a workspace the deck has dropped"), because
  // rebuilding its derived dirs races the sweep that is deleting them.
  beforeEach(() => {
    deck = [
      { id: "ws-1", roots: ["/repo"] },
      { id: "ws-2", roots: ["/repo2"] },
    ];
  });

  it("stages once per workspace, even for concurrent callers", async () => {
    const [a, b] = await Promise.all([
      manager.skillsFor(ref("ws-1")),
      manager.skillsFor(ref("ws-1")),
    ]);
    expect(a).toEqual(stagedFor("ws-1"));
    expect(b).toEqual(a);
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);

    await manager.skillsFor(ref("ws-2"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("a reused id with a NEW instance re-stages — but to the same disk id", async () => {
    // The sweep may have deleted the dead lifetime's dirs; serving the memoized
    // promise would hand the reborn workspace vanished paths.
    await manager.skillsFor(ref("ws-1", "life-1"));
    await manager.skillsFor(ref("ws-1", "life-2"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);
    // The DISK key is the durable id — that's where the user's library is.
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", []);
  });

  it("re-stages after a library edit invalidates the memo", async () => {
    await manager.skillsFor(ref("ws-1"));
    manager.invalidateSkills();
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("arms the roots the DECK reports — not a set the caller worked out", async () => {
    // The whole point of the move: a build path can no longer hand over its own
    // (possibly stale) snapshot, so it cannot arm a directory being deleted.
    deck = [{ id: "ws-1", roots: ["/wt/b", "/wt/a"] }];
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a", "/wt/b"]);
  });

  it("a new worktree in the deck re-stages — it must be armed now, not later", async () => {
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.skillsFor(ref("ws-1"));
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);

    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }];
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a", "/wt/b"]);
  });

  it("a landing cwd rides along, and does not duplicate a root already there", async () => {
    // A pane the deck cannot report yet: a journal resume or fork about to land
    // in a directory of its own.
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.skillsFor(ref("ws-1"), "/wt/new");
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a", "/wt/new"]);

    await manager.skillsFor(ref("ws-1"), "/wt/a");
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a"]);
  });

  it("answers a reborn workspace from ITS own roots, not the dead lifetime's", async () => {
    // The rule the production adapter calls load-bearing: ids are reusable,
    // lifetimes are not, and serving the dead one's roots would arm directories
    // that belonged to a workspace the user closed.
    deck = [{ id: "ws-1", roots: ["/wt/old"], instance: "life-1" }];
    await manager.skillsFor(ref("ws-1", "life-1"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/old"]);

    deck = [{ id: "ws-1", roots: ["/wt/new"], instance: "life-2" }];
    await manager.skillsFor(ref("ws-1", "life-2"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/new"]);
  });

  it("arms only what the deck STILL claims when the staging finally runs", async () => {
    // The root set is read when `skillsFor` is called, but the call can wait
    // behind a teardown. A root that left in the meantime must not be armed —
    // that is the whole failure this owner exists to prevent.
    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => held);

    const removing = manager.remove([{ repo: "/r", path: "/wt/b", branch: "b" }]);
    const arming = manager.skillsFor(ref("ws-1"));
    deck = [{ id: "ws-1", roots: ["/wt/a"] }]; // the pane left while we queued
    release();
    await removing;
    await arming;

    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a"]);
  });

  it("stages nothing for a workspace the deck has dropped", async () => {
    // Its derived dirs are on the sweep's list; rebuilding them from the library
    // would race that deletion and leave a directory nothing owns.
    deck = [];
    await expect(manager.skillsFor(ref("gone"))).resolves.toBeNull();
    expect(skills.stageSkills).not.toHaveBeenCalled();
  });

  it("does not answer a wider root set with a staging that armed less", async () => {
    // The narrowing at execution time is what keeps a departed root from being
    // armed — but the entry must then claim only what it DID arm, or the root's
    // return is served this hit and nothing ever arms it.
    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => held);

    const removing = manager.remove([{ repo: "/r", path: "/elsewhere", branch: "b" }]);
    const narrowed = manager.skillsFor(ref("ws-1")); // keyed on [a, b]
    deck = [{ id: "ws-1", roots: ["/wt/a"] }]; // b leaves while this waits
    release();
    await removing;
    await narrowed;
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a"]);

    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }]; // and b comes back
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", ["/wt/a", "/wt/b"]);
  });

  it("never answers a dead lifetime with the roots of the id's new owner", async () => {
    // Ids are reusable, lifetimes are not. A call queued for the dead one must
    // not arm the newcomer's directories when it finally runs.
    deck = [{ id: "ws-1", roots: ["/wt/old"], instance: "life-1" }];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => held);

    const removing = manager.remove([{ repo: "/r", path: "/elsewhere", branch: "b" }]);
    const stale = manager.skillsFor(ref("ws-1", "life-1"));
    deck = [{ id: "ws-1", roots: ["/wt/new"], instance: "life-2" }];
    release();
    await removing;
    await stale;

    expect(skills.stageSkills).not.toHaveBeenCalledWith("ws-1", ["/wt/new"]);
  });

  it("remembers an empty result — panes must not re-stage per spawn", async () => {
    skills.stageSkills.mockResolvedValue(null);
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);
  });
});

describe("the MCP config planted in a pane's cwd", () => {
  it("plants what it was handed, keyed by the workspace that owns the root", async () => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    mcpArming.mcpArm.mockResolvedValue({ armed: ["/repo"], refused: [] });

    expect(await manager.plantMcp("ws-1", "/repo", "{config}")).toEqual({
      armed: ["/repo"],
      refused: [],
    });
    expect(mcpArming.mcpArm).toHaveBeenCalledWith("ws-1", [
      { root: "/repo", content: "{config}" },
    ]);
  });

  it("waits for a teardown in flight, like every other write into a cwd", async () => {
    // The ordering the whole owner exists for: a write that landed between
    // git's recursive delete and its final rmdir leaves a husk git no longer
    // recognises.
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => held);
    const order: string[] = [];
    mcpArming.mcpArm.mockImplementation(async () => {
      order.push("planted");
      return { armed: ["/wt/a"], refused: [] };
    });
    mcpArming.mcpDisarm.mockImplementation(async () => {
      order.push("disarmed");
      return true;
    });

    const removing = manager.remove([{ repo: "/r", path: "/elsewhere", branch: "b" }]);
    const planting = manager.plantMcp("ws-1", "/wt/a", "{}");
    release();
    await removing;
    await planting;

    expect(order).toEqual(["disarmed", "planted"]);
  });

  it("refuses a root the deck stopped claiming while the write was queued", async () => {
    // The pane was live when the plan asked — the deck already held it — so
    // the root can only have left behind the very teardown this waited on.
    // Planting then would put a file back into a directory git has just
    // deleted, and the sweep has already passed over that root.
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worktree.removeWorktree.mockImplementation(async () => held);

    const removing = manager.remove([{ repo: "/r", path: "/wt/a", branch: "b" }]);
    const planting = manager.plantMcp("ws-1", "/wt/a", "{}");
    deck = []; // the pane left while we queued
    release();
    await removing;

    expect(await planting).toEqual({ armed: [], refused: [] });
    expect(mcpArming.mcpArm).not.toHaveBeenCalled();
  });

  it("takes its configs back from LIVE roots — that is what Off means", async () => {
    // Unlike a teardown's disarm, nothing is leaving here: the socket those
    // configs name is gone, so the panes still running in those directories
    // are exactly the ones now pointing at nothing.
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];

    expect(await manager.retractMcp(["/wt/a"])).toBe(true);

    expect(mcpArming.mcpDisarm).toHaveBeenCalledWith(["/wt/a"]);
    // And only the MCP half: the skills symlink has nothing to do with it.
    expect(skills.disarmSkills).not.toHaveBeenCalled();
  });
});

describe("sweep", () => {
  it("refuses while the deck is still loading — it would read as empty", async () => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(false);
    expect(skills.pruneSkills).not.toHaveBeenCalled();
    expect(skills.disarmSkills).not.toHaveBeenCalled();
  });

  it("prunes the workspaces that are gone, at boot and on every close", async () => {
    deck = [
      { id: "ws-1", roots: ["/repo"] },
      { id: "ws-2", roots: ["/other"] },
    ];
    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenLastCalledWith(["ws-1", "ws-2"]);

    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenLastCalledWith(["ws-1"]);
    expect(skills.disarmSkills).toHaveBeenLastCalledWith(["/other"]);
  });

  it("an empty hydrated deck sweeps everything", async () => {
    deck = [];
    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenLastCalledWith([]);
  });

  it("disarms a closing workspace's roots, late-added ones included", async () => {
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.sweep(true);
    // A worktree pane lands AFTER that sweep…
    deck = [{ id: "ws-1", roots: ["/wt/a", "/wt/b"] }];
    await manager.sweep(true);
    // …and the close still disarms BOTH of the workspace's roots.
    deck = [];
    await manager.sweep(true);
    expect(skills.disarmSkills).toHaveBeenLastCalledWith(["/wt/a", "/wt/b"]);
    expect(skills.pruneSkills).toHaveBeenLastCalledWith([]);
  });

  it("disarms only the root that left, never one the workspace still claims", async () => {
    // Panes that share a cwd are not counted here on purpose: `roots` IS the
    // claim, so a workspace keeps its cwd listed while any pane runs in it, and
    // the sweep's rule is simply "no live workspace claims this any more".
    // Sharing across WORKSPACES is covered by the teardown's own case.
    deck = [{ id: "ws-1", roots: ["/repo", "/wt/a"] }];
    await manager.sweep(true);

    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(true);

    expect(skills.disarmSkills).toHaveBeenLastCalledWith(["/wt/a"]);
    const disarmed = skills.disarmSkills.mock.calls.flatMap((call) => call[0]);
    expect(disarmed).not.toContain("/repo");
  });

  it("prunes against the deck as it is NOW, not as it was one IPC ago", async () => {
    // The list that decides what to delete used to be read before the disarm's
    // round trip, so a workspace created in that window was pruned as dead and
    // its panes spawned pointing at deleted staging dirs.
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.sweep(true); // baseline: ws-1 known

    deck = [{ id: "ws-1", roots: [] }]; // a pane closed → something to disarm
    skills.disarmSkills.mockImplementation(async (): Promise<boolean> => {
      // A new workspace lands while the disarm is in flight.
      deck = [
        { id: "ws-1", roots: [] },
        { id: "ws-2", roots: ["/repo2"] },
      ];
      return true;
    });

    await manager.sweep(true);

    expect(skills.pruneSkills).toHaveBeenLastCalledWith(["ws-1", "ws-2"]);
  });

  it("does nothing when the live set is unchanged — a rename must not cost two IPCs", async () => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenCalledTimes(1);

    // The trigger fires on every deck transition; only what the manager acts on
    // decides whether there is work.
    await manager.sweep(true);
    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenCalledTimes(1);
  });

  it("retries a pass whose housekeeping failed instead of recording it as done", async () => {
    // The IPCs swallow their own errors, so a pass that got nowhere used to be
    // remembered as having cleaned this state — and at boot that state is exactly
    // what a crash left behind.
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    skills.pruneSkills.mockResolvedValueOnce(false);

    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenCalledTimes(1);

    await manager.sweep(true); // same deck, but nothing was actually swept
    expect(skills.pruneSkills).toHaveBeenCalledTimes(2);
  });

  it("still runs the first pass on an empty deck — that is the crash sweep", async () => {
    // An empty hydrated deck compares equal to the initial state, and skipping
    // it would leave whatever an earlier session or an update left behind.
    deck = [];
    await manager.sweep(true);
    expect(skills.pruneSkills).toHaveBeenCalledWith([]);
  });

  it("coalesces a burst — six panes closing sweep the same dirs once", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    skills.pruneSkills.mockImplementationOnce(async () => {
      await held;
      return true;
    });
    deck = [{ id: "ws-1", roots: ["/repo"] }];

    const first = manager.sweep(true);
    // Three more transitions land while the first pass is still in flight.
    const rest = [manager.sweep(true), manager.sweep(true), manager.sweep(true)];
    release();
    await Promise.all([first, ...rest]);

    // ONE pass of IPCs for the whole burst. The queue serializes the four
    // requests and each one after the first finds the live set already accounted
    // for, so it costs nothing — no second mechanism needed to coalesce.
    expect(skills.pruneSkills).toHaveBeenCalledTimes(1);
  });
});
