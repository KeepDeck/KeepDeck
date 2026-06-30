/**
 * A tiny registry mapping a pane id to a function that writes text into that
 * pane's live PTY session. It lets a window-level handler (file drag-and-drop,
 * [F4]) target the specific pane under the cursor without threading session
 * handles up through React — each `TerminalPane` registers its writer on mount
 * and removes it on unmount. Pane ids are unique across the whole app (one
 * global counter), so there are no collisions.
 */
const writers = new Map<string, (text: string) => void>();

/** Register a pane's input writer; returns an unregister fn for cleanup. */
export function registerPaneInput(
  id: string,
  write: (text: string) => void,
): () => void {
  writers.set(id, write);
  return () => {
    // Only delete if it's still ours — guards against a re-mount that already
    // replaced the entry (e.g. a StrictMode double-mount).
    if (writers.get(id) === write) writers.delete(id);
  };
}

/** Write text into a pane's session. Returns false if no such pane is live. */
export function writeToPane(id: string, text: string): boolean {
  const write = writers.get(id);
  if (!write) return false;
  write(text);
  return true;
}
