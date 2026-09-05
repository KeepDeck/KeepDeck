import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisioningCard } from "../../domain/deck";
import {
  armDoubles,
  managerFor,
  provisioningCards,
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

describe("provision", () => {
  const cards = () => provisioningCards(2);

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

    await manager.provision(cards(), "ws", { onResolved, onFailed, abandoned: stays });

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
    provisioningCard(panes[0])!.base = "develop";

    await manager.provision(panes, "ws", {
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

    await manager.provision(cards(), "ws", { onResolved, onFailed, abandoned: stays });

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
    await manager.provision([{ id: "pane-1", agentType: "claude" }], "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(worktree.inspectRepo).not.toHaveBeenCalled();
    expect(worktree.createWorktree).not.toHaveBeenCalled();
  });

  it("names the branch after the workspace it is handed — nothing on the card says", async () => {
    // The auto branch name is `kd/<workspace>/<n>`, and the workspace half
    // is read by the caller as it calls: a card carries the number it was
    // born with and no name, so a Retry after a rename lands on the new one.
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({ path: "/wt/pane-1", branch: "kd/renamed/1" });

    await manager.provision(cards().slice(0, 1), "renamed", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    expect(worktree.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "renamed", index: 1 }),
    );
  });

  it("resolves the card as soon as the create lands", async () => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/pane-1",
      branch: "b1",
    });
    const onResolved = vi.fn();
    await manager.provision(cards().slice(0, 1), "ws", {
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

describe("provision — what it publishes for a racing close", () => {
  const oneCard = () => provisioningCards(1);

  beforeEach(() => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/pane-1",
      branch: "kd/ws/1",
    });
  });

  it("publishes what it made BEFORE anything that runs after the create", async () => {
    // The whole point of publishing early: the close must be able to find the
    // directory while the create is still busy — and it must not have to wait
    // for a step that runs on the pane's behalf.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    // Reaching the step IS the proof of ordering: it only runs after the create
    // published. Waiting on it beats waiting a tick, which would pass just as
    // happily on a publish that came later.
    const reachedStep = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager.registerPostProvision("pane-1", async () => {
      entered();
      await held;
    });

    const running = manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    await reachedStep;
    // Still inside the step, and the worktree is already nameable.
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

    await manager.provision(oneCard(), "ws", {
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
    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    await expect(manager.awaitCreated("pane-1")).resolves.toBeNull();
  });

  it("never deletes on a close's behalf — that ordering is the close's", async () => {
    // A create that removed its own worktree would do it before the pane's
    // process is reaped, pulling the directory out from under whatever is
    // still writing in it. And a step that failed BECAUSE the pane was closed
    // is the close, not a broken step: there is no card left to fail, and the
    // directory's fate belongs to the party that knows what the user ticked.
    worktree.removeWorktree.mockResolvedValue(undefined);
    let gone = false;
    manager.registerPostProvision("pane-1", async () => {
      gone = true;
      throw new Error("the pane was closed");
    });
    const onFailed = vi.fn();

    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed,
      abandoned: () => gone,
    });

    expect(worktree.removeWorktree).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    // Still nameable, so the close can remove it in the order it needs.
    await expect(manager.awaitCreated("pane-1")).resolves.toEqual({
      repo: "/repo",
      path: "/wt/pane-1",
      branch: "kd/ws/1",
    });
  });

  it("KEEPS the published entry when the pane left before the handover", async () => {
    // The close is the only party that knows whether the user asked for the
    // directory to go, so the create leaves it for the close to decide.
    await manager.provision(oneCard(), "ws", {
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
});

describe("provision with a post-provision step", () => {
  const oneCard = () => provisioningCards(1);

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

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays });

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

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays });

    // Through the same teardown a close uses — and with the branch sweep OFF:
    // this worktree never became a pane's, so nothing was born in it.
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/pane-1", {
      force: true,
      branch: "kd/ws/1",
      reapCreatedBranches: false,
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

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays }); // create + fail
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays }); // Retry
    expect(step).toHaveBeenCalledTimes(2); // re-run, not skipped
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
  });

  it("consumes (deletes) the step on success — a later re-provision won't re-run it", async () => {
    const step = vi.fn(async () => {});
    manager.registerPostProvision("pane-1", step);
    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(step).toHaveBeenCalledTimes(1);
    // A second provision of the same pane finds NO step → plain resolve, not re-run.
    await manager.provision(oneCard(), "ws", {
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

    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    expect(step).not.toHaveBeenCalled();
  });

  it("a plain (non-fork) pane with no registered step resolves untouched", async () => {
    const onResolved = vi.fn();
    await manager.provision(oneCard(), "ws", { onResolved, onFailed: vi.fn(), abandoned: stays });
    expect(onResolved).toHaveBeenCalledWith("pane-1", { cwd: "/wt/pane-1", branch: "kd/ws/1" });
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a rollback whose removeWorktree itself rejects still fails the card (swallowed)", async () => {
    worktree.removeWorktree.mockRejectedValue(new Error("worktree locked"));
    manager.registerPostProvision("pane-1", async () => {
      throw new Error("surgery boom");
    });
    const onFailed = vi.fn();
    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed,
      abandoned: stays,
    });
    expect(onFailed).toHaveBeenCalledWith("pane-1", "surgery boom");
  });
});
