/**
 * Builds the `PaneInput` a `TerminalPane` registers with the pane-input
 * registry. Kept as a pure, renderer-bound seam so the choice of channel —
 * raw PTY bytes for `write` vs xterm `term.paste` for `paste` — is unit-
 * testable without mounting the component (mounting would require mocking
 * xterm, the canvas addon, and the Tauri IPC sinks). Voice dictation uses the
 * raw `write` channel (pane.write mode:"type"); this seam's test keeps SPAWN
 * TASK DELIVERY on `term.paste`, so a regression that swaps `paste` back onto
 * `writePane` must turn a test red.
 */
import { registerPaneInput, type PaneInput } from "../../app/paneInput";

/** The slice of an xterm Terminal the PASTE channel needs. */
export interface PasteTarget {
  paste(text: string): void;
}

/** The raw-PTY writer the TYPE channel writes through (a bound
 * `writePane(paneId, text)` from the pty manager). */
export type RawWriter = (text: string) => void;

export function terminalPaneInput(
  term: PasteTarget,
  writeRaw: RawWriter,
): PaneInput {
  return {
    write: writeRaw,
    paste: (text) => term.paste(text),
  };
}

/**
 * Register a `TerminalPane`'s input with the pane-input registry. Owns the
 * call-site glue so the channel wiring is testable through the real registry
 * (no component mount): a `pasteToPane(paneId, ...)` after this must drive
 * `term.paste`, never the raw writer. Call sites should use this rather than
 * composing `registerPaneInput` + `terminalPaneInput` by hand, so the
 * paste-routing choice stays in one tested place.
 */
export function registerTerminalPaneInput(
  paneId: string,
  term: PasteTarget,
  writeRaw: RawWriter,
): () => void {
  return registerPaneInput(paneId, terminalPaneInput(term, writeRaw));
}
