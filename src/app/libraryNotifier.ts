/**
 * "The library changed" — said once by whichever door wrote, heard by every
 * reader on screen. Shared by every library owner the deck has (skills, MCP
 * servers): the guard against a listener re-entering through its own write,
 * and the rule that one listener's failure is not another's, have one home.
 */
export interface LibraryNotifier {
  /** Be told on every change. The returned function unsubscribes. */
  subscribe(listener: () => void): () => void;
  /**
   * Tell every listener. Not re-entrant: a listener that writes would be
   * notified by its own write, and nothing would bound the chain. A listener
   * that throws costs nothing but its own refresh — the next one still hears.
   */
  notify(): void;
}

export function createLibraryNotifier(): LibraryNotifier {
  const listeners = new Set<() => void>();
  let notifying = false;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      if (notifying) return;
      notifying = true;
      try {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // A view's refresh is not this write's problem.
          }
        }
      } finally {
        notifying = false;
      }
    },
  };
}
