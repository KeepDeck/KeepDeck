/**
 * A tiny registry mapping a pane id to the functions that write text into
 * that pane's live session. Two channels, two semantics:
 *
 *  - TYPE (`writeToPane`): raw bytes straight into the PTY, in the vein of
 *    keyboard `onData`. Used by file drag-and-drop, which shapes its own
 *    bracketed-paste wrapping around image paths and must NOT be re-wrapped.
 *  - PASTE (`pasteToPane`): routes through the pane's xterm `term.paste()`,
 *    so xterm applies its bracketed-paste wrapping exactly when the TUI has
 *    enabled it (DECSET 2004). Used by programmatic TEXT insertion — voice
 *    dictation (`pane.write`) and spawn task delivery — where the text must
 *    reach the agent the same way a hand ⌘V would, or a bracketed-paste TUI
 *    (e.g. opencode) drops the bare raw stream.
 *
 * Each `TerminalPane` registers both writers on mount and removes them on
 * unmount. Pane ids are unique across the whole app (one global counter), so
 * there are no collisions.
 */
const writers = new Map<string, (text: string) => void>();
const pasters = new Map<string, (text: string) => void>();

/** Register a pane's TYPE writer (raw PTY bytes); returns an unregister fn
 * for cleanup. */
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

/** Register a pane's PASTE writer (xterm `term.paste`); returns an unregister
 * fn for cleanup. */
export function registerPanePaste(
  id: string,
  paste: (text: string) => void,
): () => void {
  pasters.set(id, paste);
  return () => {
    if (pasters.get(id) === paste) pasters.delete(id);
  };
}

/** Whether a pane currently has a live TYPE writer — its terminal is mounted
 * and its session spawned. A pane registers both channels together on mount,
 * so this is also the readiness signal for the paste channel. The
 * task-delivery poll reads this instead of probing with an empty write. */
export function paneInputReady(id: string): boolean {
  return writers.has(id);
}

/** Write text into a pane's session as RAW bytes (type semantics). Returns
 * false if no such pane is live. */
export function writeToPane(id: string, text: string): boolean {
  const write = writers.get(id);
  if (!write) return false;
  write(text);
  return true;
}

/** Paste text into a pane's session through xterm (paste semantics — xterm
 * applies bracketed paste when the TUI enabled it). Returns false if no such
 * pane is live. */
export function pasteToPane(id: string, text: string): boolean {
  const paste = pasters.get(id);
  if (!paste) return false;
  paste(text);
  return true;
}
