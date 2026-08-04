/**
 * Wires a `TerminalPane`'s KEY events to the pane's key report — the seam
 * that keeps the answer lane honest, in the vein of [`registerTerminalPaneInput`].
 *
 * The whole guarantee behind reading "the user answered" from a terminal is
 * that this listens to `onKey` and NEVER to `onData`: xterm sends the
 * PROGRAM's own query replies — cursor position, device attributes,
 * synchronized-output support, background colour — on the data stream, so a
 * pane wired to `onData` would let an agent answer its own approval prompt
 * by repainting. That is not a rule anyone should have to remember, so
 * [`KeySource`] is the only thing this takes: a terminal's data stream is
 * not assignable to it, and rewiring to one is a compile error rather than
 * a silent regression.
 *
 * NOTE for whoever adds the next key override: a custom key handler that
 * returns `false` suppresses `onKey` entirely (xterm checks it before
 * firing), so a key this app intercepts — today Cmd+C and Shift+Enter — is
 * invisible here. Neither answers a prompt, so neither is missed; a future
 * override that IS an answer would need to report itself.
 */
import { reportPaneKey } from "../../app/paneKeys";

/** The slice of an xterm Terminal the key report needs — deliberately just
 * the one event, so nothing else can be wired here by accident. */
export interface KeySource {
  onKey(listener: (event: { key: string }) => void): { dispose(): void };
}

/** Report this pane's keystrokes for as long as the returned disposer is
 * not called. */
export function registerTerminalPaneKeys(
  paneId: string,
  term: KeySource,
): () => void {
  const subscription = term.onKey(({ key }) => reportPaneKey(paneId, key));
  return () => subscription.dispose();
}
