import { beforeEach, describe, expect, it, vi } from "vitest";

const worktree = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => worktree);

const skills = vi.hoisted(() => ({
  stageSkills: vi.fn(),
  disarmSkills: vi.fn(async (_roots: string[]) => {}),
  pruneSkills: vi.fn(async (_liveWsIds: string[]) => {}),
}));
vi.mock("../ipc/skills", () => skills);

/** The pane is still in the deck for the whole create — the ordinary case.
 * The tests that close a pane mid-create override this. */
const stays = () => false;

import type { WorkspaceRef } from "@keepdeck/plugin-api";
import type { SkillsStagingViews } from "../ipc/skills";
import { planPanes, type SetupStep } from "./provisioning";
import {
  createWorktreeManager,
  type LiveWorkspace,
  type WorktreeManager,
} from "./worktrees";

/** The workspace's setup, as the manager sees it: a step that answers. How it
 * actually runs — in the pane's own process slot — is the registry's, and is
 * covered in ptyManager.test.ts. */
const setupStep = (
  answer: { ok: boolean; tail: string },
): { step: SetupStep; calls: { paneId: string; cwd: string; branch: string }[] } => {
  const calls: { paneId: string; cwd: string; branch: string }[] = [];
  return {
    calls,
    step: (paneId, made) => {
      calls.push({ paneId, cwd: made.cwd, branch: made.branch });
      return Promise.resolve(answer);
    },
  };
};

/** The deck the manager reads, as a test double: what `live()` returns IS the
 * app's answer to which roots are claimed, and `rootsOf` answers from it. */
let deck: LiveWorkspace[] = [];

/** A fresh manager per test: its maps are per-instance precisely so no test —
 * and no workspace — inherits another's in-flight state. */
let manager: WorktreeManager;

beforeEach(() => {
  vi.clearAllMocks();
  deck = [];
  skills.stageSkills.mockImplementation(async (wsId: string) => stagedFor(wsId));
  manager = createWorktreeManager({
    rootsOf: (ref) => deck.find((ws) => ws.id === ref.id)?.roots ?? [],
    live: () => deck,
  });
});

/** A workspace REF: the id keys the disk, the instance keys the memo. */
const ref = (id: string, instance = `${id}-life-1`): WorkspaceRef => ({
  id,
  instance,
});

const stagedFor = (wsId: string): SkillsStagingViews => ({
  claudePluginDir: `/staging/${wsId}/claude-plugin`,
  opencodeConfigDir: `/staging/${wsId}/opencode`,
  skillsDir: `/staging/${wsId}/skills`,
});

describe("provision", () => {
  const cards = () =>
    planPanes({ cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" }, 1, 2, "claude");

  it("resolves each pane as its create lands, all pinned to ONE base commit", async () => {
    worktree.inspectRepo.mockResolvedValue({
      isRepo: true,
      head: "abc123",
      branch: "main",
    });
    worktree.createWorktree.mockImplementation(
      async ({ agentId }: { agentId: string }) => ({
        agentId,
        path: `/wt/${agentId}`,
        branch: `kd/ws/${agentId}`,
      }),
    );
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(cards(), { onResolved, onFailed, abandoned: stays });

    expect(onResolved).toHaveBeenCalledWith("pane-1", {
      cwd: "/wt/pane-1",
      branch: "kd/ws/pane-1",
    });
    expect(onResolved).toHaveBeenCalledWith("pane-2", {
      cwd: "/wt/pane-2",
      branch: "kd/ws/pane-2",
    });
    expect(onFailed).not.toHaveBeenCalled();
    // A concurrent batch must not straddle a moving HEAD.
    for (const call of worktree.createWorktree.mock.calls) {
      expect(call[0]).toMatchObject({ base: "abc123", baseBranch: "main" });
    }
  });

  it("a pane's picked base outranks the batch-pinned HEAD", async () => {
    worktree.inspectRepo.mockResolvedValue({
      isRepo: true,
      head: "abc123",
      branch: "main",
    });
    worktree.createWorktree.mockImplementation(
      async ({ agentId }: { agentId: string }) => ({
        agentId,
        path: `/wt/${agentId}`,
        branch: `kd/ws/${agentId}`,
      }),
    );
    const panes = cards();
    panes[0].provisioning!.base = "develop";

    await manager.provision(panes, {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    expect(worktree.createWorktree.mock.calls.map((c: any[]) => c[0].base)).toEqual([
      "develop", // its intent's own fork point
      "abc123", // the batch default
    ]);
    expect(worktree.createWorktree.mock.calls.map((c: any[]) => c[0].baseBranch)).toEqual([
      undefined, // backend derives identity from the picked branch itself
      "main", // paired with the separately pinned batch commit
    ]);
  });

  it("a failed create lands on ITS pane's card; the rest still resolve — no cwd fallback", async () => {
    worktree.inspectRepo.mockRejectedValue(new Error("no repo"));
    worktree.createWorktree
      .mockResolvedValueOnce({ agentId: "pane-1", path: "/wt/1", branch: "b1" })
      .mockRejectedValueOnce(new Error("boom"));
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(cards(), { onResolved, onFailed, abandoned: stays });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith("pane-1", {
      cwd: "/wt/1",
      branch: "b1",
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toBe("pane-2");
    expect(onFailed.mock.calls[0][1]).toContain("boom");
  });

  it("ignores panes without an intent entirely (a retry passes one card)", async () => {
    await manager.provision([{ id: "pane-1", agentType: "claude" }], {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(worktree.inspectRepo).not.toHaveBeenCalled();
    expect(worktree.createWorktree).not.toHaveBeenCalled();
  });

  it("without a setup command the card resolves straight off the create", async () => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/pane-1",
      branch: "b1",
    });
    const onResolved = vi.fn();
    await manager.provision(cards().slice(0, 1), {
      onResolved,
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(onResolved).toHaveBeenCalledWith("pane-1", {
      cwd: "/wt/pane-1",
      branch: "b1",
    });
  });
});

describe("provision with a setup command", () => {
  const oneCard = () =>
    planPanes({ cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" }, 1, 1, "claude");

  beforeEach(() => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/pane-1",
      branch: "kd/ws/1",
    });
  });

  it("runs setup against the CREATED worktree, then resolves the card", async () => {
    const { step, calls } = setupStep({ ok: true, tail: "" });
    const onResolved = vi.fn();
    const onFailed = vi.fn();
    const onSetup = vi.fn();

    await manager.provision(
      oneCard(),
      { onResolved, onFailed, onSetup, abandoned: stays },
      step,
    );

    expect(onSetup).toHaveBeenCalledWith("pane-1");
    // The path the create actually returned — not the one that was asked for.
    expect(calls).toEqual([
      { paneId: "pane-1", cwd: "/wt/pane-1", branch: "kd/ws/1" },
    ]);
    expect(onResolved).toHaveBeenCalledWith("pane-1", {
      cwd: "/wt/pane-1",
      branch: "kd/ws/1",
    });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("skips the setup command once its pane is gone, and hands nothing over", async () => {
    // The setup runs in the pane's own session slot. Spawning there after the
    // close reaped it leaves a process with nothing to reap it — and the
    // promise that step returns never settles, so anything waiting on this
    // create would wait forever.
    const { step, calls } = setupStep({ ok: true, tail: "" });
    const onResolved = vi.fn();

    await manager.provision(
      oneCard(),
      { onResolved, onFailed: vi.fn(), abandoned: () => true },
      step,
    );

    expect(calls).toEqual([]);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("publishes what it made BEFORE the setup command, so a close can name it", async () => {
    // The whole point of publishing early: the close must be able to find the
    // directory while the create is still busy — and it must not have to wait
    // for a setup step that ends only when the pane's slot is reaped.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    // Reaching the step IS the proof of ordering: it only runs after the create
    // published. Waiting on it beats waiting a tick, which would pass just as
    // happily on a publish that came later.
    const reachedSetup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const step: SetupStep = async () => {
      entered();
      await held;
      return { ok: true, tail: "" };
    };

    const running = manager.provision(
      oneCard(),
      { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays },
      step,
    );
    await reachedSetup;
    // Still inside the setup command, and the worktree is already nameable.
    await expect(manager.awaitCreated("pane-1")).resolves.toEqual({
      repo: "/repo",
      path: "/wt/pane-1",
      branch: "kd/ws/1",
    });

    release();
    await running;
  });

  it("publishes nothing when the create itself failed", async () => {
    worktree.createWorktree.mockRejectedValueOnce(new Error("boom"));

    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    // Nothing landed, so a close has nothing to remove.
    await expect(manager.awaitCreated("pane-1")).resolves.toBeNull();
  });

  it("hands the entry back once the pane owns its worktree", async () => {
    // Past the handover the pane has a cwd, so the deck names the worktree and
    // this entry would only be a second, staler handle on it.
    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    await expect(manager.awaitCreated("pane-1")).resolves.toBeNull();
  });

  it("KEEPS the published entry when the pane left before the handover", async () => {
    // The close is the only party that knows whether the user asked for the
    // directory to go, so the create leaves it for the close to decide.
    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: () => true,
    });

    await expect(manager.awaitCreated("pane-1")).resolves.toEqual({
      repo: "/repo",
      path: "/wt/pane-1",
      branch: "kd/ws/1",
    });
  });

  it("never deletes on a close's behalf — that ordering is the close's", async () => {
    // A create that removed its own worktree would do it before the pane's
    // process is reaped, pulling the directory out from under a setup command
    // that is still writing into it.
    worktree.removeWorktree.mockResolvedValue(undefined);
    let gone = false;
    const step: SetupStep = async () => {
      gone = true;
      return { ok: false, tail: "the pane was closed" };
    };
    const onFailed = vi.fn();

    await manager.provision(
      oneCard(),
      { onResolved: vi.fn(), onFailed, abandoned: () => gone },
      step,
    );

    expect(worktree.removeWorktree).not.toHaveBeenCalled();
    // The interrupted command is the close, not a broken setup: no card is
    // left to put that on.
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("a failed setup rolls the worktree back and lands the tail on the card", async () => {
    const { step } = setupStep({ ok: false, tail: "npm ERR! boom" });
    worktree.removeWorktree.mockResolvedValue(undefined);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), { onResolved, onFailed, abandoned: stays }, step);

    // Rollback, so Retry re-creates instead of hitting "already exists".
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/pane-1", {
      force: true,
      branch: "kd/ws/1",
    });
    expect(onResolved).not.toHaveBeenCalled();
    const [paneId, error] = onFailed.mock.calls[0];
    expect(paneId).toBe("pane-1");
    expect(error).toBe("Setup failed: npm ERR! boom");
  });

  it("a step that could not run at all fails the card the same way", async () => {
    const { step } = setupStep({ ok: false, tail: "spawn failed" });
    worktree.removeWorktree.mockResolvedValue(undefined);
    const onFailed = vi.fn();

    await manager.provision(
      oneCard(),
      { onResolved: vi.fn(), onFailed, abandoned: stays },
      step,
    );

    expect(onFailed).toHaveBeenCalledWith("pane-1", "Setup failed: spawn failed");
  });
});

describe("provision with a post-provision step", () => {
  const oneCard = () =>
    planPanes({ cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" }, 1, 1, "claude");

  beforeEach(() => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({ path: "/wt/pane-1", branch: "kd/ws/1" });
    worktree.removeWorktree.mockResolvedValue(undefined);
  });

  it("runs the registered step bound to the CREATED worktree, then resolves", async () => {
    const step = vi.fn(async () => {});
    manager.registerPostProvision("pane-1", step);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), { onResolved, onFailed, abandoned: stays });

    expect(step).toHaveBeenCalledWith({ cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(onFailed).not.toHaveBeenCalled();
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a step failure rolls the worktree back and fails the card — never resolves", async () => {
    manager.registerPostProvision("pane-1", async () => {
      throw new Error("Agent could not prepare a fork plan");
    });
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), { onResolved, onFailed, abandoned: stays });

    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/pane-1", {
      force: true,
      branch: "kd/ws/1",
    });
    expect(onFailed).toHaveBeenCalledWith("pane-1", "Agent could not prepare a fork plan");
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("RETRY re-runs the SAME step (the fix): a failed-then-retried fork keeps its surgery", async () => {
    // The step fails the first attempt, succeeds the second — proving a failed
    // step stays registered and re-runs, instead of resolving a plain pane.
    let attempt = 0;
    const step = vi.fn(async () => {
      if (attempt++ === 0) throw new Error("transient");
    });
    manager.registerPostProvision("pane-1", step);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), { onResolved, onFailed, abandoned: stays }); // create + fail
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();

    await manager.provision(oneCard(), { onResolved, onFailed, abandoned: stays }); // Retry
    expect(step).toHaveBeenCalledTimes(2); // re-run, not skipped
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
  });

  it("consumes (deletes) the step on success — a later re-provision won't re-run it", async () => {
    const step = vi.fn(async () => {});
    manager.registerPostProvision("pane-1", step);
    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(step).toHaveBeenCalledTimes(1);
    // A second provision of the same pane finds NO step → plain resolve, not re-run.
    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(step).toHaveBeenCalledTimes(1); // consumed on success, not 2
  });

  it("a cleared step never runs — an abandoned fork has no Retry coming", async () => {
    // A fork card closed instead of retried leaves its step registered (kept
    // across failures on purpose), and a pane id is never reused, so the close
    // drops it explicitly.
    const step = vi.fn(async () => {});
    manager.registerPostProvision("pane-1", step);
    manager.clearPostProvision("pane-1");

    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    expect(step).not.toHaveBeenCalled();
  });

  it("a plain (non-fork) pane with no registered step resolves untouched", async () => {
    const onResolved = vi.fn();
    await manager.provision(oneCard(), { onResolved, onFailed: vi.fn(), abandoned: stays });
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a rollback whose removeWorktree itself rejects still fails the card (swallowed)", async () => {
    worktree.removeWorktree.mockRejectedValue(new Error("worktree locked"));
    manager.registerPostProvision("pane-1", async () => {
      throw new Error("surgery boom");
    });
    const onFailed = vi.fn();
    await manager.provision(oneCard(), {
      onResolved: vi.fn(),
      onFailed,
      abandoned: stays,
    });
    expect(onFailed).toHaveBeenCalledWith("pane-1", "surgery boom");
  });
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

  it("remembers an empty result — panes must not re-stage per spawn", async () => {
    skills.stageSkills.mockResolvedValue(null);
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(await manager.skillsFor(ref("ws-1"))).toBeNull();
    expect(skills.stageSkills).toHaveBeenCalledTimes(1);
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

  it("keeps a root another pane still claims", async () => {
    deck = [{ id: "ws-1", roots: ["/repo", "/wt/a"] }];
    await manager.sweep(true);

    // The worktree pane closed: its cwd is nobody's now.
    deck = [{ id: "ws-1", roots: ["/repo"] }];
    await manager.sweep(true);
    expect(skills.disarmSkills).toHaveBeenLastCalledWith(["/wt/a"]);

    // One of the panes sharing the workspace cwd closed; the other still runs
    // there, so that root must stay armed.
    await manager.sweep(true);
    const disarmed = skills.disarmSkills.mock.calls.flatMap((call) => call[0]);
    expect(disarmed).not.toContain("/repo");
  });

  it("coalesces a burst — six panes closing sweep the same dirs once", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    skills.pruneSkills.mockImplementationOnce(async () => held);
    deck = [{ id: "ws-1", roots: ["/repo"] }];

    const first = manager.sweep(true);
    // Three more transitions land while the first pass is still in flight.
    const rest = [manager.sweep(true), manager.sweep(true), manager.sweep(true)];
    release();
    await Promise.all([first, ...rest]);

    // One pass for the burst, not one per request.
    expect(skills.pruneSkills).toHaveBeenCalledTimes(2);
  });
});

describe("the ordering between arming and teardown", () => {
  // The race this manager was built for: staging arms every live root with a
  // `.agents/skills` symlink, and a removal deletes a root's directory. One
  // landing inside the other leaves a husk git can no longer even name.
  it("takes its own hooks out of a directory before git touches it", async () => {
    const order: string[] = [];
    skills.disarmSkills.mockImplementation(async (roots) => {
      order.push(`disarm:${roots.join(",")}`);
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
