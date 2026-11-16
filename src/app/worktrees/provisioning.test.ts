import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  armDoubles,
  managerFor,
  provisionRequests,
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
  const cards = () => provisionRequests(2);

  it("resolves each pane as its create lands, all pinned to ONE base commit", async () => {
    worktree.inspectRepo.mockResolvedValue({
      isRepo: true,
      head: "abc123",
      branch: "main",
    });
    worktree.createWorktree.mockImplementation(
      async ({ ownerId }: { ownerId: string }) => ({
        path: `/wt/${ownerId}`,
        branch: `kd/ws/${ownerId}`,
      }),
    );
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(cards(), "ws", { onResolved, onFailed, abandoned: stays });

    expect(onResolved).toHaveBeenCalledWith("team-1", {
      cwd: "/wt/team-1",
      branch: "kd/ws/team-1",
    });
    expect(onResolved).toHaveBeenCalledWith("team-2", {
      cwd: "/wt/team-2",
      branch: "kd/ws/team-2",
    });
    expect(onFailed).not.toHaveBeenCalled();
    // A concurrent batch must not straddle a moving HEAD — and each create
    // is asked under the TEAM's id, never a member's.
    for (const call of worktree.createWorktree.mock.calls) {
      expect(call[0]).toMatchObject({ base: "abc123", baseBranch: "main" });
      expect(call[0].ownerId).toMatch(/^team-\d+$/);
      expect(call[0]).not.toHaveProperty("agentId");
    }
  });

  it("a pane's picked base outranks the batch-pinned HEAD", async () => {
    worktree.inspectRepo.mockResolvedValue({
      isRepo: true,
      head: "abc123",
      branch: "main",
    });
    worktree.createWorktree.mockImplementation(
      async ({ ownerId }: { ownerId: string }) => ({
        path: `/wt/${ownerId}`,
        branch: `kd/ws/${ownerId}`,
      }),
    );
    const requests = cards();
    requests[0].intent.base = "develop";

    await manager.provision(requests, "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    expect(worktree.createWorktree.mock.calls.map((c) => c[0].base)).toEqual([
      "develop", // its intent's own fork point
      "abc123", // the batch default
    ]);
    expect(worktree.createWorktree.mock.calls.map((c) => c[0].baseBranch)).toEqual([
      undefined, // backend derives identity from the picked branch itself
      "main", // paired with the separately pinned batch commit
    ]);
  });

  it("a failed create lands on ITS pane's card; the rest still resolve — no cwd fallback", async () => {
    worktree.inspectRepo.mockRejectedValue(new Error("no repo"));
    worktree.createWorktree
      .mockResolvedValueOnce({ path: "/wt/1", branch: "b1" })
      .mockRejectedValueOnce(new Error("boom"));
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(cards(), "ws", { onResolved, onFailed, abandoned: stays });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith("team-1", {
      cwd: "/wt/1",
      branch: "b1",
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toBe("team-2");
    expect(onFailed.mock.calls[0][1]).toContain("boom");
  });

  it("does nothing for an empty batch", async () => {
    await manager.provision([], "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(worktree.inspectRepo).not.toHaveBeenCalled();
    expect(worktree.createWorktree).not.toHaveBeenCalled();
  });

  it("takes out the ticket BEFORE the repo is inspected, so a close in that window has something to wait for", async () => {
    // The orphan: a close confirmed while `inspectRepo` was still pending
    // used to find no entry, delete the owner, and leave the directory the
    // create then made with nobody to name it. The ticket exists from the
    // moment the create is asked for.
    let inspected!: (value: { head: string }) => void;
    worktree.inspectRepo.mockReturnValue(
      new Promise<{ head: string }>((resolve) => {
        inspected = resolve;
      }),
    );
    worktree.createWorktree.mockResolvedValue({ path: "/wt/team-1", branch: "kd/ws/1" });
    const running = manager.provision(cards().slice(0, 1), "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });
    // Asked while the inspect is still pending: a ticket, not null.
    const waiting = manager.awaitCreated("team-1");
    inspected({ head: "abc" });
    await running;
    expect(await waiting).toEqual({ repo: "/repo", path: "/wt/team-1", branch: "kd/ws/1" });
  });

  it("starts ONE create for an owner asked twice before the first answers — a second Retry coalesces", async () => {
    // Two creates for one directory race each other on disk, and a close
    // waits on only the latest ticket: the earlier create's worktree would
    // be nobody's to name or remove. The second request finds a ticket out
    // for its owner and is dropped.
    let inspected!: (value: { head: string }) => void;
    worktree.inspectRepo.mockReturnValue(
      new Promise<{ head: string }>((resolve) => {
        inspected = resolve;
      }),
    );
    worktree.createWorktree.mockResolvedValue({ path: "/wt/team-1", branch: "kd/ws/1" });
    const onResolved = vi.fn();
    const cb = { onResolved, onFailed: vi.fn(), abandoned: stays };
    const first = manager.provision(cards().slice(0, 1), "ws", cb);
    const second = manager.provision(cards().slice(0, 1), "ws", cb);
    const waiting = manager.awaitCreated("team-1");
    inspected({ head: "abc" });
    await Promise.all([first, second]);
    expect(worktree.createWorktree).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(await waiting).toEqual({ repo: "/repo", path: "/wt/team-1", branch: "kd/ws/1" });
  });

  it("names the branch after the workspace it is handed EACH time — a Retry after a rename lands on the new name", async () => {
    // The auto branch name is `kd/<workspace>/<n>`, and the workspace half
    // is read by the caller as it calls: a card carries the number it was
    // born with and no name. The same runner, asked twice for the same card
    // under two names, must not remember the first.
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ path: "/wt/team-1", branch: "kd/renamed/1" });
    const cb = { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays };

    await manager.provision(cards().slice(0, 1), "ws", cb); // create + fail
    await manager.provision(cards().slice(0, 1), "renamed", cb); // Retry, renamed between

    expect(worktree.createWorktree.mock.calls.map((c) => c[0].workspace)).toEqual([
      "ws",
      "renamed",
    ]);
  });

  it("resolves the card as soon as the create lands", async () => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/team-1",
      branch: "b1",
    });
    const onResolved = vi.fn();
    await manager.provision(cards().slice(0, 1), "ws", {
      onResolved,
      onFailed: vi.fn(),
      abandoned: stays,
    });
    expect(onResolved).toHaveBeenCalledWith("team-1", {
      cwd: "/wt/team-1",
      branch: "b1",
    });
  });
});

describe("provision — what it publishes for a racing close", () => {
  const oneCard = () => provisionRequests(1);

  beforeEach(() => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/team-1",
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
    manager.registerPostProvision("team-1", async () => {
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
    await expect(manager.awaitCreated("team-1")).resolves.toEqual({
      repo: "/repo",
      path: "/wt/team-1",
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
    await expect(manager.awaitCreated("team-1")).resolves.toBeNull();
  });

  it("hands the entry back once the pane owns its worktree", async () => {
    // Past the handover the pane has a cwd, so the deck names the worktree and
    // this entry would only be a second, staler handle on it.
    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
      abandoned: stays,
    });

    await expect(manager.awaitCreated("team-1")).resolves.toBeNull();
  });

  it("never deletes on a close's behalf — that ordering is the close's", async () => {
    // A create that removed its own worktree would do it before the pane's
    // process is reaped, pulling the directory out from under whatever is
    // still writing in it. And a step that failed BECAUSE the pane was closed
    // is the close, not a broken step: there is no card left to fail, and the
    // directory's fate belongs to the party that knows what the user ticked.
    worktree.removeWorktree.mockResolvedValue(undefined);
    let gone = false;
    manager.registerPostProvision("team-1", async () => {
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
    await expect(manager.awaitCreated("team-1")).resolves.toEqual({
      repo: "/repo",
      path: "/wt/team-1",
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

    await expect(manager.awaitCreated("team-1")).resolves.toEqual({
      repo: "/repo",
      path: "/wt/team-1",
      branch: "kd/ws/1",
    });
  });
});

describe("provision with a post-provision step", () => {
  const oneCard = () => provisionRequests(1);

  beforeEach(() => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({ path: "/wt/team-1", branch: "kd/ws/1" });
    worktree.removeWorktree.mockResolvedValue(undefined);
  });

  it("runs the registered step bound to the CREATED worktree, then resolves", async () => {
    const step = vi.fn(async () => {});
    manager.registerPostProvision("team-1", step);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays });

    expect(step).toHaveBeenCalledWith({ cwd: "/wt/team-1", branch: "kd/ws/1" });
    expect(onResolved).toHaveBeenCalledWith("team-1", { cwd: "/wt/team-1", branch: "kd/ws/1" });
    expect(onFailed).not.toHaveBeenCalled();
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a step failure rolls the worktree back and fails the card — never resolves", async () => {
    manager.registerPostProvision("team-1", async () => {
      throw new Error("Agent could not prepare a fork plan");
    });
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays });

    // Through the same teardown a close uses — and with the branch sweep OFF:
    // this worktree never became a pane's, so nothing was born in it.
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/team-1", {
      discardDirty: true,
      discardUnmerged: true,
      branch: "kd/ws/1",
      reapCreatedBranches: false,
    });
    expect(onFailed).toHaveBeenCalledWith("team-1", "Agent could not prepare a fork plan");
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("RETRY re-runs the SAME step (the fix): a failed-then-retried fork keeps its surgery", async () => {
    // The step fails the first attempt, succeeds the second — proving a failed
    // step stays registered and re-runs, instead of resolving a plain pane.
    let attempt = 0;
    const step = vi.fn(async () => {
      if (attempt++ === 0) throw new Error("transient");
    });
    manager.registerPostProvision("team-1", step);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays }); // create + fail
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();

    await manager.provision(oneCard(), "ws", { onResolved, onFailed, abandoned: stays }); // Retry
    expect(step).toHaveBeenCalledTimes(2); // re-run, not skipped
    expect(onResolved).toHaveBeenCalledWith("team-1", { cwd: "/wt/team-1", branch: "kd/ws/1" });
  });

  it("consumes (deletes) the step on success — a later re-provision won't re-run it", async () => {
    const step = vi.fn(async () => {});
    manager.registerPostProvision("team-1", step);
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
    manager.registerPostProvision("team-1", step);
    manager.clearPostProvision("team-1");

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
    expect(onResolved).toHaveBeenCalledWith("team-1", { cwd: "/wt/team-1", branch: "kd/ws/1" });
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("a rollback whose removeWorktree itself rejects still fails the card (swallowed)", async () => {
    worktree.removeWorktree.mockRejectedValue(new Error("worktree locked"));
    manager.registerPostProvision("team-1", async () => {
      throw new Error("surgery boom");
    });
    const onFailed = vi.fn();
    await manager.provision(oneCard(), "ws", {
      onResolved: vi.fn(),
      onFailed,
      abandoned: stays,
    });
    expect(onFailed).toHaveBeenCalledWith("team-1", "surgery boom");
  });
});

describe("awaitSettled — the END of a create, not its git call", () => {
  const oneCard = () => provisionRequests(1);

  beforeEach(() => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({ path: "/wt/team-1", branch: "kd/ws/1" });
    worktree.removeWorktree.mockResolvedValue(undefined);
  });

  it("answers none when no create is in flight", async () => {
    expect(await manager.awaitSettled("team-1")).toBe("none");
  });

  it("waits past the git call for the post-provision step and the card's resolve", async () => {
    // The fork's case: `awaitCreated` answers when the worktree is on disk,
    // while its store surgery — work done on the owner's behalf — still runs.
    let stepDone!: () => void;
    manager.registerPostProvision(
      "team-1",
      () =>
        new Promise<void>((resolve) => {
          stepDone = resolve;
        }),
    );
    const order: string[] = [];
    const onResolved = vi.fn(() => order.push("resolved"));
    const running = manager.provision(oneCard(), "ws", { onResolved, onFailed: vi.fn(), abandoned: stays });
    const settling = manager.awaitSettled("team-1").then((ended) => order.push(`settled:${ended}`));
    await manager.awaitCreated("team-1");
    await vi.waitFor(() => expect(stepDone).toBeTypeOf("function"));
    expect(order).toEqual([]);
    stepDone();
    await running;
    await settling;
    expect(order).toEqual(["resolved", "settled:resolved"]);
    // Ended: nothing in flight any more.
    expect(await manager.awaitSettled("team-1")).toBe("none");
  });

  it("is asked for from the moment the create is, before the repo is even inspected", async () => {
    let inspected!: (value: { head: string }) => void;
    worktree.inspectRepo.mockReturnValue(
      new Promise<{ head: string }>((resolve) => {
        inspected = resolve;
      }),
    );
    const running = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    const waiting = manager.awaitSettled("team-1");
    inspected({ head: "abc" });
    await running;
    expect(await waiting).toBe("resolved");
  });

  it("settles failed for a create git refused, and for a step that failed and rolled back", async () => {
    worktree.createWorktree.mockRejectedValueOnce(new Error("refused"));
    const first = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    const refused = manager.awaitSettled("team-1");
    await first;
    expect(await refused).toBe("failed");

    manager.registerPostProvision("team-1", async () => {
      throw new Error("no plan");
    });
    const second = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    const rolledBack = manager.awaitSettled("team-1");
    await second;
    expect(await rolledBack).toBe("failed");
    expect(worktree.removeWorktree).toHaveBeenCalled();
  });

  it("settles abandoned when the owner left mid-create", async () => {
    const running = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: () => true });
    const waiting = manager.awaitSettled("team-1");
    await running;
    expect(await waiting).toBe("abandoned");
  });

  it("is ONE settlement for every waiter, and reading it consumes nothing", async () => {
    const running = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    const one = manager.awaitSettled("team-1");
    const two = manager.awaitSettled("team-1");
    expect(one).toBe(two);
    await running;
    expect(await Promise.all([one, two])).toEqual(["resolved", "resolved"]);
  });

  it("a Retry is a create of its own: the waiter on the failed one keeps that one's end", async () => {
    worktree.createWorktree.mockRejectedValueOnce(new Error("refused"));
    const failed = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    const onFailedOne = manager.awaitSettled("team-1");
    await failed;
    const retry = manager.provision(oneCard(), "ws", { onResolved: vi.fn(), onFailed: vi.fn(), abandoned: stays });
    const onRetry = manager.awaitSettled("team-1");
    expect(onRetry).not.toBe(onFailedOne);
    await retry;
    expect(await onFailedOne).toBe("failed");
    expect(await onRetry).toBe("resolved");
  });

  it("a Retry issued from the failure itself is still waited for — the old end never drops the new create", async () => {
    worktree.createWorktree.mockRejectedValueOnce(new Error("refused"));
    let retry: Promise<void> | undefined;
    const cb = {
      onResolved: vi.fn(),
      onFailed: vi.fn(() => {
        retry ??= manager.provision(oneCard(), "ws", cb);
      }),
      abandoned: stays,
    };
    await manager.provision(oneCard(), "ws", cb);
    const onRetry = manager.awaitSettled("team-1");
    expect(retry).toBeDefined();
    await retry;
    expect(await onRetry).toBe("resolved");
  });

  it("settles even when a callback throws — a waiter is never left hanging", async () => {
    const running = manager.provision(oneCard(), "ws", {
      onResolved: () => {
        throw new Error("the deck refused it");
      },
      onFailed: vi.fn(),
      abandoned: stays,
    });
    const waiting = manager.awaitSettled("team-1");
    await expect(running).rejects.toThrow("the deck refused it");
    expect(await waiting).toBe("failed");
  });
});
