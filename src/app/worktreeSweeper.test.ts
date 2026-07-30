import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckPersistence } from "./deckPersistence";
import { createDeckStore } from "./deckStore";
import type { WorktreeHousekeeping } from "./worktrees";
import { createWorktreeSweeper } from "./worktreeSweeper";

describe("the app-lifetime worktree sweep trigger", () => {
  const sweep = vi.fn(async () => {});
  const worktrees: WorktreeHousekeeping = { sweep };

  let persistenceListeners: Set<() => void>;
  let restoring: boolean;
  let frozen: boolean;

  beforeEach(() => {
    sweep.mockClear();
    restoring = true;
    frozen = false;
    persistenceListeners = new Set();
  });

  const mount = () => {
    const deck = createDeckStore();
    const persistence: DeckPersistence = {
      getSnapshot: () => ({
        restoring,
        frozen: frozen ? { kind: "unreadable" } : null,
      }),
      subscribe(listener) {
        persistenceListeners.add(listener);
        return () => persistenceListeners.delete(listener);
      },
      dispose: () => {},
    };
    return {
      deck,
      sweeper: createWorktreeSweeper(deck, persistence, worktrees),
      publishPersistence: () => {
        for (const listener of [...persistenceListeners]) listener();
      },
    };
  };

  it("passes hydration readiness to the manager", () => {
    const { sweeper, publishPersistence } = mount();
    expect(sweep).toHaveBeenLastCalledWith(false);

    restoring = false;
    publishPersistence();
    expect(sweep).toHaveBeenLastCalledWith(true);
    sweeper.dispose();
  });

  it("asks the manager again on every deck transition", () => {
    restoring = false;
    const { deck, sweeper } = mount();
    sweep.mockClear();

    deck.dispatch({ type: "selectWorkspace", id: "missing" });
    expect(sweep).toHaveBeenCalledOnce();
    sweeper.dispose();
  });

  it("stops triggering after disposal", () => {
    const { deck, sweeper, publishPersistence } = mount();
    sweeper.dispose();
    sweep.mockClear();

    restoring = false;
    publishPersistence();
    deck.dispatch({ type: "selectWorkspace", id: "missing" });
    expect(sweep).not.toHaveBeenCalled();
  });
});
