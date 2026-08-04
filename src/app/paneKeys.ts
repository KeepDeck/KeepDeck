/**
 * The user's own keystrokes in a pane — reported by the terminal view, read
 * by whoever needs to know that a HUMAN acted.
 *
 * This is deliberately NOT the pane's write path. Everything typed does reach
 * the agent through `writePane`, but so does traffic no user produced: xterm
 * answers the program's own terminal queries on its behalf — cursor position
 * (`ESC[6n`), device attributes, synchronized-output support, the background
 * colour — and fires those replies on the very same `onData` the keyboard
 * uses. codex's TUI asks all four. Reading intent off the byte stream
 * therefore let an agent answer its own approval prompt: the pane went from
 * "Needs approval" to "Working" because it repainted after a resize.
 *
 * xterm's `onKey` carries only real key events, so provenance comes from the
 * seam rather than from guessing at bytes. Paste and programmatic writes are
 * excluded by the same construction — no one answers a yes/no prompt by
 * pasting, and a wait that outlives this signal still clears when the agent's
 * own edge arrives.
 */

const listeners = new Set<(paneId: string, data: string) => void>();

/** A key the user pressed in this pane, as the bytes it encodes to. */
export function reportPaneKey(paneId: string, data: string): void {
  for (const listener of [...listeners]) listener(paneId, data);
}

/** Notify on every user keystroke, for any pane. */
export function subscribePaneKeys(
  listener: (paneId: string, data: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
