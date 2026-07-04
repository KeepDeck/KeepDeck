import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspaces";

const ports = vi.hoisted(() => ({ allocatePorts: vi.fn() }));
vi.mock("../ipc/ports", () => ports);

const pty = vi.hoisted(() => ({ closePane: vi.fn(() => Promise.resolve()) }));
vi.mock("./ptyManager", () => pty);

const ids = vi.hoisted(() => ({ mintAgentSeq: vi.fn(() => 42) }));
vi.mock("./ids", () => ids);

import { peekPaneSpawnSpec, resetPaneSpawnSpecs } from "./spawnSpecs";
import { useRunPane } from "./useRunPane";
import type { Deck } from "./useDeck";

/** The hook uses no React state — a plain fake deck drives it directly. */
function fakeDeck(workspaces: Workspace[]) {
  return {
    workspaces,
    addAgentPane: vi.fn(),
    sleepPane: vi.fn(),
    revivePane: vi.fn(),
  } as unknown as Deck & {
    addAgentPane: ReturnType<typeof vi.fn>;
    sleepPane: ReturnType<typeof vi.fn>;
    revivePane: ReturnType<typeof vi.fn>;
  };
}

const ws = (panes: Workspace["panes"] = []): Workspace => ({
  id: "ws-1",
  name: "app",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
});

beforeEach(() => {
  vi.clearAllMocks();
  ports.allocatePorts.mockResolvedValue(17_040);
});
afterEach(resetPaneSpawnSpecs);

describe("launch", () => {
  it("allocates the port for the source worktree, registers the plan, adds the pane", async () => {
    const deck = fakeDeck([ws()]);
    await useRunPane(deck).launch(
      "ws-1",
      { cwd: "/wt/agent-3", branch: "kd/app/3" },
      { presetId: "run-1", command: "pnpm dev", name: "Dev" },
    );

    expect(ports.allocatePorts).toHaveBeenCalledWith("/wt/agent-3");
    expect(peekPaneSpawnSpec("pane-42")).toEqual({
      args: ["-c", "pnpm dev"],
      env: [
        ["KEEPDECK_WORKTREE", "/wt/agent-3"],
        ["KEEPDECK_BRANCH", "kd/app/3"],
        ["KEEPDECK_PORT", "17040"],
      ],
    });
    expect(deck.addAgentPane).toHaveBeenCalledWith("ws-1", {
      id: "pane-42",
      name: "Dev",
      run: { command: "pnpm dev", presetId: "run-1" },
      cwd: "/wt/agent-3",
      branch: "kd/app/3",
    });
  });

  it("runs in the workspace folder when the source pane has no worktree", async () => {
    const deck = fakeDeck([ws()]);
    await useRunPane(deck).launch("ws-1", {}, { command: "make dev", name: "make dev" });

    expect(ports.allocatePorts).toHaveBeenCalledWith("/repo");
    const pane = deck.addAgentPane.mock.calls[0][1];
    expect(pane.cwd).toBeUndefined(); // spawns into the ws cwd fallback
    expect(pane.run).toEqual({ command: "make dev" });
  });

  it("refuses to launch past the 16-pane grid cap", async () => {
    const full = ws(
      Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, agentType: "claude" as const })),
    );
    const deck = fakeDeck([full]);
    await useRunPane(deck).launch("ws-1", {}, { command: "pnpm dev", name: "Dev" });

    // Refused before any side effect — no port probe, no silent reducer drop.
    expect(ports.allocatePorts).not.toHaveBeenCalled();
    expect(deck.addAgentPane).not.toHaveBeenCalled();
  });

  it("a failed port allocation degrades to a plan without KEEPDECK_PORT", async () => {
    ports.allocatePorts.mockRejectedValue(new Error("range exhausted"));
    const deck = fakeDeck([ws()]);
    await useRunPane(deck).launch("ws-1", {}, { command: "pnpm dev", name: "Dev" });

    const env = peekPaneSpawnSpec("pane-42")?.env.map(([k]) => k);
    expect(env).toEqual(["KEEPDECK_WORKTREE"]);
    expect(deck.addAgentPane).toHaveBeenCalled(); // the pane still lands
  });
});

describe("runAgain", () => {
  const runPane = {
    id: "pane-7",
    run: { command: "pnpm dev" },
    cwd: "/wt/7",
    branch: "kd/app/7",
  };

  it("closes the old PTY entry, sleeps the live pane, re-plans with a fresh port, revives", async () => {
    const deck = fakeDeck([ws([runPane])]);
    await useRunPane(deck).runAgain("ws-1", "pane-7");

    expect(pty.closePane).toHaveBeenCalledWith("pane-7");
    expect(deck.sleepPane).toHaveBeenCalledWith("ws-1", "pane-7");
    expect(peekPaneSpawnSpec("pane-7")?.env).toContainEqual([
      "KEEPDECK_PORT",
      "17040",
    ]);
    expect(deck.revivePane).toHaveBeenCalledWith("ws-1", "pane-7");
  });

  it("skips the sleep for an already-dormant pane (the restored Run tile)", async () => {
    const deck = fakeDeck([ws([{ ...runPane, dormant: true }])]);
    await useRunPane(deck).runAgain("ws-1", "pane-7");

    expect(deck.sleepPane).not.toHaveBeenCalled();
    expect(deck.revivePane).toHaveBeenCalledWith("ws-1", "pane-7");
  });

  it("is a no-op on a pane that isn't a run pane", async () => {
    const deck = fakeDeck([ws([{ id: "pane-9", agentType: "claude" }])]);
    await useRunPane(deck).runAgain("ws-1", "pane-9");

    expect(pty.closePane).not.toHaveBeenCalled();
    expect(deck.revivePane).not.toHaveBeenCalled();
  });
});
