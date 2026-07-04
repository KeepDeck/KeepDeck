// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let deck: Deck;
let flow: ReturnType<typeof useCloseFlow>;
// The [F6] confirm-before-close preference the Probe renders with.
let confirmPref = true;

function Probe() {
  deck = useDeck();
  flow = useCloseFlow(deck, () => {}, confirmPref);
  return null;
}

/** A workspace with two panes, one on its own worktree (a discard target). */
function seed() {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", agentType: "claude" },
        { id: "pane-2", agentType: "claude", cwd: "/wt/2", branch: "kd/ws/2" },
      ],
    });
  });
  return "ws-1";
}

describe("useCloseFlow + ptyManager", () => {
  let root: Root;

  beforeEach(() => {
    pty.closePanes.mockClear();
    worktrees.discardWorktrees.mockClear();
    worktrees.order.length = 0;
    confirmPref = true;
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
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-2"]);
  });

  it("closing a workspace ends every pane's session", () => {
    const wsId = seed();
    act(() => flow.requestCloseWorkspace(wsId));
    act(() => flow.confirmClose());
    expect(pty.closePanes).toHaveBeenCalledWith(["pane-1", "pane-2"]);
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
    act(() => flow.requestCloseWorkspace(wsId));
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

  it("cancel closes nothing", () => {
    const wsId = seed();
    act(() => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    act(() => flow.cancelClose());
    expect(pty.closePanes).not.toHaveBeenCalled();
    expect(deck.workspaces[0].panes).toHaveLength(2);
  });

  it("with confirmation off, a request closes immediately — no dialog", () => {
    confirmPref = false;
    act(() => root.render(createElement(Probe)));
    const wsId = seed();
    act(() => flow.requestCloseAgent(wsId, "pane-1", "Agent 1"));
    expect(flow.closing).toBeNull(); // never parked for a dialog
    expect(pty.closePanes).toHaveBeenCalledWith(["pane-1"]);
    expect(deck.workspaces[0].panes.map((p) => p.id)).toEqual(["pane-2"]);
  });

  it("with confirmation off, worktrees are NEVER deleted", async () => {
    // The delete opt-in checkbox lives inside the skipped dialog, so this
    // path must not be able to discard work.
    confirmPref = false;
    act(() => root.render(createElement(Probe)));
    const wsId = seed(); // pane-2 runs on its own worktree
    act(() => flow.requestCloseWorkspace(wsId));
    await act(async () => {});
    expect(pty.closePanes).toHaveBeenCalledWith(["pane-1", "pane-2"]);
    expect(worktrees.discardWorktrees).not.toHaveBeenCalled();
  });
});
