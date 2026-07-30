import type { DeckPersistence } from "./deckPersistence";
import type { DeckStore } from "./deckStore";
import type { WorktreeHousekeeping } from "./worktrees";

export interface WorktreeSweeper {
  dispose(): void;
}

/**
 * App-lifetime trigger for worktree housekeeping. The manager remains the only
 * owner of the live-root projection and decides whether a transition requires
 * IPC; this service only supplies deck transitions and hydration readiness.
 */
export function createWorktreeSweeper(
  deck: DeckStore,
  persistence: DeckPersistence,
  worktrees: WorktreeHousekeeping,
): WorktreeSweeper {
  let disposed = false;

  const reconcile = () => {
    if (disposed) return;
    const status = persistence.getSnapshot();
    void worktrees.sweep(!status.restoring && status.frozen === null);
  };

  const unsubscribeDeck = deck.subscribe(reconcile);
  const unsubscribePersistence = persistence.subscribe(reconcile);
  reconcile();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeDeck();
      unsubscribePersistence();
    },
  };
}
