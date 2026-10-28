import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  armDoubles,
  managerFor,
  cwdArming,
  mcpLibrary,
  pluginDirs,
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

  it("stages without the rows the codec finds no description in — judged here, not natively", async () => {
    skills.fetchSkills.mockResolvedValue([
      { scope: "global", wsId: null, name: "fine", content: "---\ndescription: Reviews\n---\n" },
      { scope: "global", wsId: null, name: "bare", content: "no frontmatter" },
    ]);
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenLastCalledWith("ws-1", [
      { scope: "global", wsId: null, name: "bare" },
    ]);
  });

  it("stages nothing when the library cannot be read to judge it", async () => {
    skills.fetchSkills.mockRejectedValue(new Error("unreadable"));
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(skills.stageSkills).not.toHaveBeenCalled();
  });

  it("re-stages after a library edit invalidates the memo", async () => {
    await manager.skillsFor(ref("ws-1"));
    manager.invalidateSkills();
    await manager.skillsFor(ref("ws-1"));
    expect(skills.stageSkills).toHaveBeenCalledTimes(2);
  });

  it("remembers an empty result — panes must not re-stage per spawn", async () => {
    skills.stageSkills.mockResolvedValue(null);
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);
  });
});

describe("what an agent's plugin plants in a pane's cwd", () => {
  const request = (cwd: string) => ({
    pluginId: "p",
    workspaceId: "ws-1",
    cwd,
    arms: [{ kind: "file" as const, path: ".agent/conf", content: "{}" }],
    skillsDir: null,
  });

  it("plants the request as it was handed, and answers what landed", async () => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    cwdArming.cwdArm.mockResolvedValue({ armed: [".agent/conf"], refused: [] });

    expect(await manager.armCwd(request("/repo"))).toEqual({ armed: [".agent/conf"], refused: [] });
    expect(cwdArming.cwdArm).toHaveBeenCalledWith(request("/repo"));
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
    cwdArming.cwdArm.mockImplementation(async () => {
      order.push("planted");
      return { armed: [".agent/conf"], refused: [] };
    });
    cwdArming.cwdDisarm.mockImplementation(async () => {
      order.push("disarmed");
      return true;
    });

    const removing = manager.remove([{ repo: "/r", path: "/elsewhere", branch: "b" }]);
    const planting = manager.armCwd(request("/wt/a"));
    release();
    await removing;
    await planting;

    expect(order).toEqual(["disarmed", "planted"]);
  });

  it("plants into a cwd the deck cannot see YET — that is the normal case", async () => {
    // A manual resume, a fork into a directory and a fork into a fresh
    // worktree all build their plan BEFORE the pane lands, so the deck does
    // not claim the cwd at write time. Narrowing against the live set here
    // (as `skillsFor` must, because it arms a whole snapshotted SET) refused
    // exactly those three flows, silently.
    deck = [{ id: "ws-1", roots: [] }];
    cwdArming.cwdArm.mockResolvedValue({ armed: [".agent/conf"], refused: [] });

    expect(await manager.armCwd(request("/wt/landing"))).toEqual({ armed: [".agent/conf"], refused: [] });
    expect(cwdArming.cwdArm).toHaveBeenCalledWith(request("/wt/landing"));
  });
});

describe("sweep", () => {
  it("refuses while the deck is still loading — it would read as empty", async () => {
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(false);
    expect(skills.pruneSkills).not.toHaveBeenCalled();
    expect(cwdArming.cwdDisarm).not.toHaveBeenCalled();
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
    expect(cwdArming.cwdDisarm).toHaveBeenLastCalledWith(["/other"]);
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
    expect(cwdArming.cwdDisarm).toHaveBeenLastCalledWith(["/wt/a", "/wt/b"]);
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

    expect(cwdArming.cwdDisarm).toHaveBeenLastCalledWith(["/wt/a"]);
    const disarmed = cwdArming.cwdDisarm.mock.calls.flatMap((call) => call[0]);
    expect(disarmed).not.toContain("/repo");
  });

  it("prunes against the deck as it is NOW, not as it was one IPC ago", async () => {
    // The list that decides what to delete used to be read before the disarm's
    // round trip, so a workspace created in that window was pruned as dead and
    // its panes spawned pointing at deleted staging dirs.
    deck = [{ id: "ws-1", roots: ["/wt/a"] }];
    await manager.sweep(true); // baseline: ws-1 known

    deck = [{ id: "ws-1", roots: [] }]; // a pane closed → something to disarm
    cwdArming.cwdDisarm.mockImplementation(async (): Promise<boolean> => {
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

  it("sweeps the MCP library's workspace scopes with the same live set", async () => {
    // The crash path: a workspace the deck lost without closing it never had
    // its scope forgotten, and its id will be handed to the next one.
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(true);
    expect(mcpLibrary.pruneMcpLibrary).toHaveBeenLastCalledWith(["ws-1"]);

    // Its failure is a failed pass like any other: the next sweep retries.
    deck = [{ id: "ws-2", roots: ["/repo2"] }];
    mcpLibrary.pruneMcpLibrary.mockResolvedValueOnce(false);
    await manager.sweep(true);
    await manager.sweep(true);
    expect(mcpLibrary.pruneMcpLibrary).toHaveBeenCalledTimes(3);
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

  it("prunes plugins' directories by the same live ids, and retries a pass they failed", async () => {
    deck = [{ id: "ws-2", roots: ["/b"] }, { id: "ws-1", roots: ["/a"] }];
    pluginDirs.prune.mockResolvedValueOnce(false);
    await manager.sweep(true);
    expect(pluginDirs.prune).toHaveBeenCalledWith(["ws-1", "ws-2"]);
    await manager.sweep(true);
    expect(pluginDirs.prune).toHaveBeenCalledTimes(2);
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
