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
 * seam rather than from guessing at bytes.
 *
 * What that construction also excludes, deliberately: a paste, a file
 * drag-and-drop, voice dictation, and an MCP `pane.write` — every path that
 * reaches the agent as bytes rather than as a keypress. The first two answer
 * no prompt; the last two could, and a wait they answer stands until the
 * agent's own edge lands. That is the pre-existing behaviour, not a
 * regression, and it is the price of a signal that cannot be forged by the
 * agent itself. Reporting those paths too would mean deciding, at each of
 * them, whether the writer was the user — which is exactly the guess this
 * module exists to stop making.
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
