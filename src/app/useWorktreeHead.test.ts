// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckState } from "../domain/deck";
import type { WorktreeHead } from "../ipc/worktree";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";
import { useWorktreeHead } from "./useWorktreeHead";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ipc = vi.hoisted(() => ({
  onWorktreeHead: vi.fn(),
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn(),
}));
vi.mock("../ipc/worktree", () => ({
  onWorktreeHead: ipc.onWorktreeHead,
  watchWorktree: ipc.watchWorktree,
  unwatchWorktree: ipc.unwatchWorktree,
}));

let deck: Deck;

function Probe() {
  deck = useDeck();
  useWorktreeHead(deck);
  return null;
}

/** A deck with one worktree pane and one workspace-cwd pane. */
const restored = (): DeckState => ({
  workspaces: [
    {
      id: "ws-1",
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        { id: "pane-1", cwd: "/wt/one", branch: "kd/ws/1" },
        { id: "pane-2" },
      ],
    },
  ],
  activeId: "ws-1",
  focusByWs: {},
  selectByWs: {},
});

/** Let the listen→ready→watch effect chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};

describe("useWorktreeHead — live branch badge", () => {
  let root: Root;
  // The subscribed event handler, captured from the hook's onWorktreeHead call.
  let emit: (head: WorktreeHead) => void;

  beforeEach(() => {
    ipc.onWorktreeHead.mockReset().mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    ipc.watchWorktree.mockReset().mockResolvedValue(undefined);
    ipc.unwatchWorktree.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const pane = () => deck.workspaces[0].panes[0];

  it("watches each worktree pane's cwd once, and not workspace-cwd panes", async () => {
    act(() => deck.hydrate(restored()));
    await settle();

    expect(ipc.watchWorktree).toHaveBeenCalledTimes(1);
    expect(ipc.watchWorktree).toHaveBeenCalledWith("/wt/one");

    // Unrelated deck churn must not re-register the same path.
    act(() => deck.renamePane("ws-1", "pane-1", "renamed"));
    await settle();
    expect(ipc.watchWorktree).toHaveBeenCalledTimes(1);
  });

  it("records a checkout on the pane at that path", async () => {
    act(() => deck.hydrate(restored()));
    await settle();

    act(() => emit({ path: "/wt/one", branch: "feature/x", head: null }));
    expect(pane().branch).toBe("feature/x");

    // Detach: the branch gives way to the commit id.
    const sha = "a".repeat(40);
    act(() => emit({ path: "/wt/one", branch: null, head: sha }));
    expect(pane().branch).toBeUndefined();
    expect(pane().head).toBe(sha);
  });

  it("ignores an event for a path no pane runs at (raced a close)", async () => {
    act(() => deck.hydrate(restored()));
    await settle();

    act(() => emit({ path: "/wt/gone", branch: "x", head: null }));
    expect(pane().branch).toBe("kd/ws/1");
  });

  it("unwatches when the pane closes", async () => {
    act(() => deck.hydrate(restored()));
    await settle();

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();
    expect(ipc.unwatchWorktree).toHaveBeenCalledWith("/wt/one");
  });

  it("retries a failed registration on the next deck change (dir restored)", async () => {
    ipc.watchWorktree.mockRejectedValueOnce(new Error("gone"));
    act(() => deck.hydrate(restored()));
    await settle();
    expect(ipc.watchWorktree).toHaveBeenCalledTimes(1);

    ipc.watchWorktree.mockResolvedValue(undefined);
    act(() => deck.renamePane("ws-1", "pane-1", "kick"));
    await settle();
    expect(ipc.watchWorktree).toHaveBeenCalledTimes(2);
    expect(ipc.watchWorktree).toHaveBeenLastCalledWith("/wt/one");
  });
});
