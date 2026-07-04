import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneSink } from "./ptyManager";

const worktree = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => worktree);

const pty = vi.hoisted(() => ({
  acquirePane: vi.fn(),
  attachPane: vi.fn(),
  closePane: vi.fn(() => Promise.resolve()),
}));
vi.mock("./ptyManager", () => pty);

import {
  discardWorktrees,
  planPanes,
  provisionInto,
  runProvisioning,
} from "./provisioning";

/** Arm the pty mock to end every setup session with `script`. */
function setupSessionEndsWith(script: (sink: PaneSink) => void) {
  pty.attachPane.mockImplementation((_paneId: string, sink: PaneSink) => {
    queueMicrotask(() => script(sink));
    return () => {};
  });
}

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

  it("without a setup command, no PTY session is ever involved", async () => {
    worktree.inspectRepo.mockResolvedValue({ head: "abc" });
    worktree.createWorktree.mockResolvedValue({
      path: "/wt/pane-1",
      branch: "b1",
    });
    await runProvisioning(cards().slice(0, 1), {
      onResolved: vi.fn(),
      onFailed: vi.fn(),
    });
    expect(pty.acquirePane).not.toHaveBeenCalled();
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

  it("runs setup in the created worktree via the pane's PTY slot, then resolves", async () => {
    setupSessionEndsWith((sink) => sink.onExit(0));
    const onResolved = vi.fn();
    const onFailed = vi.fn();
    const onSetup = vi.fn();

    await runProvisioning(oneCard(), { onResolved, onFailed, onSetup }, "pnpm i");

    expect(onSetup).toHaveBeenCalledWith("pane-1");
    expect(pty.acquirePane).toHaveBeenCalledWith(
      "pane-1",
      expect.objectContaining({
        command: null, // the user's shell
        args: ["-c", "pnpm i"],
        cwd: "/wt/pane-1",
        env: expect.arrayContaining([["KEEPDECK_WORKTREE", "/wt/pane-1"]]),
      }),
    );
    // The slot is released for the pane's real terminal to take over.
    expect(pty.closePane).toHaveBeenCalledWith("pane-1");
    expect(onResolved).toHaveBeenCalledWith("pane-1", {
      cwd: "/wt/pane-1",
      branch: "kd/ws/1",
    });
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("a failed setup rolls the worktree back and lands the output tail on the card", async () => {
    setupSessionEndsWith((sink) => {
      sink.onOutput(new TextEncoder().encode("\x1b[31mnpm ERR! boom\x1b[0m\n"));
      sink.onExit(1);
    });
    worktree.removeWorktree.mockResolvedValue(undefined);
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    await runProvisioning(oneCard(), { onResolved, onFailed }, "pnpm i");

    // Rollback, so Retry re-creates instead of hitting "already exists".
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/pane-1", {
      force: true,
      branch: "kd/ws/1",
    });
    expect(onResolved).not.toHaveBeenCalled();
    const [paneId, error] = onFailed.mock.calls[0];
    expect(paneId).toBe("pane-1");
    // The tail is plain text — ANSI colors from the tool are stripped.
    expect(error).toBe("Setup failed: npm ERR! boom");
  });

  it("a spawn error (no shell) fails the card like a nonzero exit", async () => {
    setupSessionEndsWith((sink) => sink.onSpawnError("spawn failed"));
    worktree.removeWorktree.mockResolvedValue(undefined);
    const onFailed = vi.fn();

    await runProvisioning(oneCard(), { onResolved: vi.fn(), onFailed }, "pnpm i");

    expect(onFailed).toHaveBeenCalledWith("pane-1", "Setup failed: spawn failed");
  });
});

describe("provisionInto", () => {
  it("routes results into the deck's provisioning actions for that workspace", () => {
    const deck = {
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
      setPaneProvisioningPhase: vi.fn(),
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
  });
});
