import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worktree = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => worktree);

/** The pane is still in the deck for the whole create — the ordinary case.
 * The tests that close a pane mid-create override this. */
const stays = () => false;

import {
  clearPostProvision,
  discardWorktreeOnArrival,
  discardWorktrees,
  planPanes,
  provisionInto,
  registerPostProvision,
  runProvisioning,
  setupStepFor,
  type SetupStep,
} from "./provisioning";

/** The workspace's setup, as provisioning sees it: a step that answers. How
 * it actually runs — in the pane's own process slot — is the registry's, and
 * is covered in ptyManager.test.ts. */
const setupStep = (
  answer: { ok: boolean; tail: string },
): { step: SetupStep; calls: { paneId: string; cwd: string; branch: string }[] } => {
  const calls: { paneId: string; cwd: string; branch: string }[] = [];
  return {
    calls,
    step: (paneId, worktree) => {
      calls.push({ paneId, cwd: worktree.cwd, branch: worktree.branch });
      return Promise.resolve(answer);
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planPanes", () => {
  it("builds bare panes when the workspace has no worktree base", () => {
    expect(
      planPanes(
        { cwd: "/repo", worktreeBaseDir: null, name: "ws" },
        5,
        2,
        "claude",
      ),
    ).toEqual([
      { id: "pane-5", agentType: "claude" },
      { id: "pane-6", agentType: "claude" },
    ]);
  });

  it("builds provisioning cards in worktree mode — synchronously, no git calls", () => {
    const panes = planPanes(
      { cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" },
      1,
      2,
      "codex",
    );
    expect(panes.map((p) => p.provisioning?.index)).toEqual([1, 2]);
    expect(panes[0].provisioning).toMatchObject({
      repo: "/repo",
      baseDir: "/wt",
      workspace: "ws",
    });
    expect(worktree.inspectRepo).not.toHaveBeenCalled();
    expect(worktree.createWorktree).not.toHaveBeenCalled();
  });
});

describe("runProvisioning", () => {
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

    await runProvisioning(cards(), { onResolved, onFailed, abandoned: stays });

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
      expect(call[0]).toMatchObject({ base: "abc123" });
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

    await runProvisioning(panes, { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });

    expect(worktree.createWorktree.mock.calls.map((c: any[]) => c[0].base)).toEqual([
      "develop", // its intent's own fork point
      "abc123", // the batch default
    ]);
  });

  it("a failed create lands on ITS pane's card; the rest still resolve — no cwd fallback", async () => {
    worktree.inspectRepo.mockRejectedValue(new Error("no repo"));
    worktree.createWorktree
      .mockResolvedValueOnce({ agentId: "pane-1", path: "/wt/1", branch: "b1" })
      .mockRejectedValueOnce(new Error("boom"));
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(cards(), { onResolved, onFailed, abandoned: stays });

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
    await runProvisioning([{ id: "pane-1", agentType: "claude" }], {
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
    await runProvisioning(cards().slice(0, 1), { onResolved, onFailed: vi.fn(), abandoned: stays });
    expect(onResolved).toHaveBeenCalledWith("pane-1", {
      cwd: "/wt/pane-1",
      branch: "b1",
    });
  });
});

describe("runProvisioning with a setup command", () => {
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

    await runProvisioning(oneCard(), { onResolved, onFailed, onSetup, abandoned: stays }, step);

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

    await runProvisioning(
      oneCard(),
      { onResolved, onFailed: vi.fn(), abandoned: () => true },
      step,
    );

    expect(calls).toEqual([]);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("removes the worktree its closed pane asked it to, once the create lands", async () => {
    worktree.removeWorktree.mockResolvedValue(undefined);
    discardWorktreeOnArrival("pane-1");

    await runProvisioning(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: () => true,
    });

    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/pane-1", {
      force: true,
      branch: "kd/ws/1",
    });
  });

  it("removes the worktree of a pane closed DURING its setup command", async () => {
    // The window the create is most likely to be closed in, and the one that
    // used to escape: the setup step ends when the pane's slot is reaped, and
    // while that step could never settle, nothing after it ever ran — so the
    // worktree the user asked to delete was simply left on disk.
    worktree.removeWorktree.mockResolvedValue(undefined);
    // The close lands WHILE the command runs, so the pre-setup check has
    // already passed — this is the window that used to escape entirely.
    let gone = false;
    const step: SetupStep = async () => {
      gone = true;
      return { ok: false, tail: "the pane was closed" };
    };
    const onFailed = vi.fn();
    discardWorktreeOnArrival("pane-1");

    await runProvisioning(
      oneCard(),
      { onResolved: vi.fn(), onFailed, abandoned: () => gone },
      step,
    );

    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/pane-1", {
      force: true,
      branch: "kd/ws/1",
    });
    // The interrupted command is the close, not a broken setup: there is no
    // card left to put that on.
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("KEEPS a mid-setup pane's worktree when the delete was not asked for", async () => {
    // Same window, no request. The interrupted command comes back not-ok, and
    // the ordinary setup-failure path would roll the worktree back — but this
    // user closed WITHOUT ticking the box, which is a deliberate keep.
    worktree.removeWorktree.mockResolvedValue(undefined);
    let gone = false;
    const step: SetupStep = async () => {
      gone = true;
      return { ok: false, tail: "the pane was closed" };
    };

    await runProvisioning(
      oneCard(),
      { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: () => gone },
      step,
    );

    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("KEEPS the worktree of a pane closed without asking for the delete", async () => {
    // Closing without ticking the box is a deliberate "keep it"; a create that
    // happened to still be running must not turn that into a delete.
    worktree.removeWorktree.mockResolvedValue(undefined);

    await runProvisioning(oneCard(), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: () => true,
    });

    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a failed setup rolls the worktree back and lands the tail on the card", async () => {
    const { step } = setupStep({ ok: false, tail: "npm ERR! boom" });
    worktree.removeWorktree.mockResolvedValue(undefined);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(oneCard(), { onResolved, onFailed, abandoned: stays }, step);

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

    await runProvisioning(oneCard(), { onResolved: vi.fn(), onFailed, abandoned: stays }, step);

    expect(onFailed).toHaveBeenCalledWith("pane-1", "Setup failed: spawn failed");
  });
});

describe("setupStepFor", () => {
  it("runs the command through the user's shell in the created worktree", async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true, tail: "" }));
    const step = setupStepFor("pnpm i", run);

    await step("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });

    expect(run).toHaveBeenCalledWith("pane-1", {
      command: null, // the user's shell
      args: ["-c", "pnpm i"],
      env: [
        ["KEEPDECK_WORKTREE", "/wt/pane-1"],
        ["KEEPDECK_BRANCH", "kd/ws/1"],
      ],
      cwd: "/wt/pane-1",
      cols: 80,
      rows: 24,
    });
  });

  it("omits KEEPDECK_PORT — setup runs before any port is allocated", async () => {
    // The workspace env contract the Run plugin implements independently:
    // two implementers of one convention, and this is where they differ.
    const seen: [string, string][][] = [];
    await setupStepFor("x", (_paneId, spec) => {
      seen.push(spec.env);
      return Promise.resolve({ ok: true, tail: "" });
    })("pane-1", { cwd: "/wt/a", branch: "b" });
    expect(seen[0].map(([name]) => name)).not.toContain("KEEPDECK_PORT");
  });
});

describe("runProvisioning with a post-provision step", () => {
  const oneCard = () =>
    planPanes({ cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" }, 1, 1, "claude");

  beforeEach(() => {
    clearPostProvision("pane-1"); // the module map outlives clearAllMocks
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({ path: "/wt/pane-1", branch: "kd/ws/1" });
    worktree.removeWorktree.mockResolvedValue(undefined);
  });
  // A step KEPT across a failure (the last test) must not leak into other blocks.
  afterEach(() => clearPostProvision("pane-1"));

  it("runs the registered step bound to the CREATED worktree, then resolves", async () => {
    const step = vi.fn(async () => {});
    registerPostProvision("pane-1", step);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(oneCard(), { onResolved, onFailed, abandoned: stays });

    expect(step).toHaveBeenCalledWith({ cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(onFailed).not.toHaveBeenCalled();
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a step failure rolls the worktree back and fails the card — never resolves", async () => {
    registerPostProvision("pane-1", async () => {
      throw new Error("Agent could not prepare a fork plan");
    });
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(oneCard(), { onResolved, onFailed, abandoned: stays });

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
    registerPostProvision("pane-1", step);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(oneCard(), { onResolved, onFailed, abandoned: stays }); // create + fail
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();

    await runProvisioning(oneCard(), { onResolved, onFailed, abandoned: stays }); // Retry re-provisions
    expect(step).toHaveBeenCalledTimes(2); // re-run, not skipped
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
  });

  it("consumes (deletes) the step on success — a later re-provision won't re-run it", async () => {
    const step = vi.fn(async () => {});
    registerPostProvision("pane-1", step);
    await runProvisioning(oneCard(), { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    expect(step).toHaveBeenCalledTimes(1);
    // A second provision of the same pane finds NO step → plain resolve, not re-run.
    await runProvisioning(oneCard(), { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    expect(step).toHaveBeenCalledTimes(1); // consumed on success, not 2
  });

  it("a plain (non-fork) pane with no registered step resolves untouched", async () => {
    const onResolved = vi.fn();
    await runProvisioning(oneCard(), { onResolved, onFailed: vi.fn(), abandoned: stays });
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a rollback whose removeWorktree itself rejects still fails the card (swallowed)", async () => {
    worktree.removeWorktree.mockRejectedValue(new Error("worktree locked"));
    registerPostProvision("pane-1", async () => {
      throw new Error("surgery boom");
    });
    const onFailed = vi.fn();
    await runProvisioning(oneCard(), { onResolved: vi.fn(), onFailed, abandoned: stays });
    expect(onFailed).toHaveBeenCalledWith("pane-1", "surgery boom");
  });
});

describe("provisionInto", () => {
  it("routes results into the deck's provisioning actions for that workspace", () => {
    const deck = {
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
      setPaneProvisioningPhase: vi.fn(),
      hasPane: vi.fn(() => true),
    };
    const cb = provisionInto(deck, "ws-1");
    cb.onResolved("pane-1", { cwd: "/wt/1", branch: "b1" });
    cb.onFailed("pane-2", "boom");
    cb.onSetup?.("pane-3");
    expect(deck.resolvePaneProvisioning).toHaveBeenCalledWith("ws-1", "pane-1", {
      cwd: "/wt/1",
      branch: "b1",
    });
    expect(deck.setPaneProvisioningError).toHaveBeenCalledWith(
      "ws-1",
      "pane-2",
      "boom",
    );
    expect(deck.setPaneProvisioningPhase).toHaveBeenCalledWith(
      "ws-1",
      "pane-3",
      "setup",
    );
  });
});

describe("discardWorktrees", () => {
  it("keeps tearing down after a failure and collects its message", async () => {
    worktree.removeWorktree
      .mockRejectedValueOnce(new Error("dirty"))
      .mockResolvedValueOnce(undefined);
    const failures = await discardWorktrees([
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
