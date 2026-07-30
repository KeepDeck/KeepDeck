import { beforeEach, describe, expect, it, vi } from "vitest";

const worktree = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => worktree);

import { planPanes, provisionInto, setupStepFor } from "./provisioning";

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

  it("reports a pane the deck no longer holds as abandoned", () => {
    // The create asks this after every await that could outlive its pane, so a
    // sink that merely no-ops is not enough — it has to answer.
    const deck = {
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
      setPaneProvisioningPhase: vi.fn(),
      hasPane: vi.fn(() => false),
    };
    expect(provisionInto(deck, "ws-1").abandoned("pane-9")).toBe(true);
    expect(deck.hasPane).toHaveBeenCalledWith("ws-1", "pane-9");
  });
});
