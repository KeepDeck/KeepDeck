import { beforeEach, describe, expect, it, vi } from "vitest";

const worktree = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => worktree);

import { discardWorktrees, provisionPanes } from "./provisioning";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionPanes", () => {
  it("builds bare panes (no git calls) when the workspace has no worktree base", async () => {
    const panes = await provisionPanes(
      { cwd: "/repo", worktreeBaseDir: null, name: "ws" },
      5,
      2,
      "claude",
      () => {},
    );
    expect(panes).toEqual([
      { id: "pane-5", agentType: "claude" },
      { id: "pane-6", agentType: "claude" },
    ]);
    expect(worktree.createWorktree).not.toHaveBeenCalled();
  });

  it("pins one base commit and gives each pane its worktree record", async () => {
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
    const panes = await provisionPanes(
      { cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" },
      1,
      2,
      "claude",
      () => {},
    );
    expect(panes[0]).toMatchObject({ id: "pane-1", cwd: "/wt/pane-1" });
    expect(panes[1]).toMatchObject({ id: "pane-2", branch: "kd/ws/pane-2" });
    // Both creates share the SAME resolved base — a concurrent batch must not
    // straddle a moving HEAD.
    expect(worktree.createWorktree).toHaveBeenCalledTimes(2);
    for (const call of worktree.createWorktree.mock.calls) {
      expect(call[0]).toMatchObject({ base: "abc123" });
    }
  });

  it("falls back to a cwd pane and reports when one create fails", async () => {
    worktree.inspectRepo.mockRejectedValue(new Error("no repo"));
    worktree.createWorktree
      .mockResolvedValueOnce({ agentId: "pane-1", path: "/wt/1", branch: "b1" })
      .mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    const panes = await provisionPanes(
      { cwd: "/repo", worktreeBaseDir: "/wt", name: "ws" },
      1,
      2,
      "claude",
      onError,
    );
    expect(panes[0]).toMatchObject({ cwd: "/wt/1" });
    expect(panes[1]).toEqual({ id: "pane-2", agentType: "claude" });
    expect(onError).toHaveBeenCalledTimes(1);
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
