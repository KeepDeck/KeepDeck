import { beforeEach, describe, expect, it, vi } from "vitest";

const worktree = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => worktree);

import {
  discardWorktrees,
  planPanes,
  provisionInto,
  runProvisioning,
} from "./provisioning";

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

    await runProvisioning(cards(), { onResolved, onFailed });

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

  it("a failed create lands on ITS pane's card; the rest still resolve — no cwd fallback", async () => {
    worktree.inspectRepo.mockRejectedValue(new Error("no repo"));
    worktree.createWorktree
      .mockResolvedValueOnce({ agentId: "pane-1", path: "/wt/1", branch: "b1" })
      .mockRejectedValueOnce(new Error("boom"));
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(cards(), { onResolved, onFailed });

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
    });
    expect(worktree.inspectRepo).not.toHaveBeenCalled();
    expect(worktree.createWorktree).not.toHaveBeenCalled();
  });
});

describe("provisionInto", () => {
  it("routes results into the deck's provisioning actions for that workspace", () => {
    const deck = {
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
    };
    const cb = provisionInto(deck, "ws-1");
    cb.onResolved("pane-1", { cwd: "/wt/1", branch: "b1" });
    cb.onFailed("pane-2", "boom");
    expect(deck.resolvePaneProvisioning).toHaveBeenCalledWith("ws-1", "pane-1", {
      cwd: "/wt/1",
      branch: "b1",
    });
    expect(deck.setPaneProvisioningError).toHaveBeenCalledWith(
      "ws-1",
      "pane-2",
      "boom",
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
  });
});
