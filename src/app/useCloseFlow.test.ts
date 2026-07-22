// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathProbe } from "../domain/agents";
import type { GitPosition } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useCloseFlow } from "./useCloseFlow";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pty = vi.hoisted(() => ({
  closePanes: vi.fn<(ids: string[]) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("./ptyManager", () => pty);

const lifecycle = vi.hoisted(() => ({
  dropPaneSpawnSpec: vi.fn(),
  clearPaneUsage: vi.fn(),
}));
vi.mock("./spawnSpecs", () => ({
  dropPaneSpawnSpec: lifecycle.dropPaneSpawnSpec,
}));
vi.mock("./usageManager", () => ({
  clearPaneUsage: lifecycle.clearPaneUsage,
}));

const worktrees = vi.hoisted(() => ({
  order: [] as string[],
  discardWorktrees: vi.fn<() => Promise<string[]>>(() => {
    worktrees.order.push("discard");
    return Promise.resolve([]);
  }),
}));
vi.mock("./provisioning", () => ({
  discardWorktrees: worktrees.discardWorktrees,
}));

const probes = vi.hoisted(() => ({
  probeWorktree: vi.fn<(path: string) => Promise<PathProbe>>(),
}));
vi.mock("../ipc/worktree", () => ({
  probeWorktree: probes.probeWorktree,
}));

/** A probe answer: the dir is there (a plain worktree) or it's gone. */
function probed(exists: boolean): PathProbe {
  return { exists, isWorktree: exists, empty: false, branch: null };
}

let deck: Deck;
let flow: ReturnType<typeof useCloseFlow>;
let runtimeHeads: Map<string, GitPosition>;

function Probe() {
  deck = useDeck();
  flow = useCloseFlow(deck, () => {}, runtimeHeads);
  return null;
}

/** A workspace with two panes, one on its own worktree (a discard target),
 * plus any extra worktree panes a test needs. */
function seed(extra: { id: string; cwd: string; branch: string }[] = []) {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude" },
        { id: "pane-2", agentType: "claude", cwd: "/wt/2", branch: "kd/ws/2" },
        ...extra.map((p) => ({ ...p, agentType: "claude" })),
      ],
    });
  });
  return "ws-1";
}

describe("useCloseFlow + ptyManager", () => {
  let root: Root;

  beforeEach(() => {
    pty.closePanes.mockClear();
    lifecycle.dropPaneSpawnSpec.mockClear();
    lifecycle.clearPaneUsage.mockClear();
    worktrees.discardWorktrees.mockClear();
    worktrees.order.length = 0;
    probes.probeWorktree.mockReset();
    probes.probeWorktree.mockResolvedValue(probed(true));
    runtimeHeads = new Map();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("closing an agent ends exactly that pane's session", () => {
    const wsId = seed();
    act(() => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.confirmClose());
    expect(pty.closePanes).toHaveBeenCalledWith(["pane-1"]);
    expect(lifecycle.dropPaneSpawnSpec).toHaveBeenCalledWith("pane-1");
    expect(lifecycle.clearPaneUsage).toHaveBeenCalledWith("pane-1");
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-2"]);
  });

  it("closing a workspace ends every pane's session", async () => {
    const wsId = seed();
    // The dialog opens only after the worktree probe answers.
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.confirmClose());
    expect(pty.closePanes).toHaveBeenCalledWith(["pane-1", "pane-2"]);
    expect(lifecycle.dropPaneSpawnSpec.mock.calls).toEqual([
      ["pane-1"],
      ["pane-2"],
    ]);
    expect(lifecycle.clearPaneUsage.mock.calls).toEqual([
      ["pane-1"],
      ["pane-2"],
    ]);
    expect(deck.workspaces).toHaveLength(0);
  });

  it("discards worktrees only after the session closes settle", async () => {
    const wsId = seed();
    let releaseClose!: () => void;
    pty.closePanes.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = () => {
            worktrees.order.push("closed");
            resolve();
          };
        }),
    );
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => {
      flow.setDeleteWorktree(true);
    });
    act(() => flow.confirmClose());
    expect(worktrees.discardWorktrees).not.toHaveBeenCalled();
    releaseClose();
    await act(async () => {});
    expect(worktrees.order).toEqual(["closed", "discard"]);
    expect(worktrees.discardWorktrees).toHaveBeenCalledTimes(1);
  });

  it("uses the observed current branch when discarding an owned worktree", async () => {
    runtimeHeads.set("/wt/2", { branch: "feature/current" });
    const wsId = seed();
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    await act(async () => {});

    expect(worktrees.discardWorktrees).toHaveBeenCalledWith([
      { repo: "/repo", path: "/wt/2", branch: "feature/current" },
    ]);
  });

  it("a gone worktree is not offered for deletion", async () => {
    probes.probeWorktree.mockResolvedValue(probed(false));
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));

    expect(probes.probeWorktree).toHaveBeenCalledWith("/wt/2");
    expect(flow.closing).not.toBeNull();
    expect(flow.closing!.targets).toEqual([]);

    // Even a forced checkbox can't discard: the snapshot holds no targets.
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    await act(async () => {});
    expect(worktrees.discardWorktrees).not.toHaveBeenCalled();
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-1"]);
  });

  it("a workspace close keeps only the worktrees that still exist", async () => {
    probes.probeWorktree.mockImplementation((path) =>
      Promise.resolve(probed(path !== "/wt/2")),
    );
    const wsId = seed([{ id: "pane-3", cwd: "/wt/3", branch: "kd/ws/3" }]);
    await act(async () => flow.requestCloseWorkspace(wsId));
    act(() => flow.setDeleteWorktree(true));
    act(() => flow.confirmClose());
    await act(async () => {});

    expect(worktrees.discardWorktrees).toHaveBeenCalledWith([
      { repo: "/repo", path: "/wt/3", branch: "kd/ws/3" },
    ]);
  });

  it("an unanswerable probe keeps the delete offer", async () => {
    probes.probeWorktree.mockRejectedValue(new Error("ipc down"));
    const wsId = seed();
    await act(async () => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));

    expect(flow.closing!.targets).toEqual([
      { repo: "/repo", path: "/wt/2", branch: "kd/ws/2" },
    ]);
  });

  it("a newer close request wins over a slower probe", async () => {
    let answer!: (probe: PathProbe) => void;
    probes.probeWorktree.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const wsId = seed();
    // The worktree pane's request hangs on its probe...
    act(() => flow.requestCloseAgent(wsId, "pane-2", "Agent 2"));
    // ...and a plain pane's request opens synchronously meanwhile.
    act(() => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closing).toMatchObject({ kind: "agent", paneId: "pane-1" });

    await act(async () => answer(probed(true)));
    expect(flow.closing).toMatchObject({ kind: "agent", paneId: "pane-1" });
  });

  it("cancel closes nothing", () => {
    const wsId = seed();
    act(() => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.cancelClose());
    expect(pty.closePanes).not.toHaveBeenCalled();
    expect(deck.workspaces[0].panes).toHaveLength(2);
  });
});
