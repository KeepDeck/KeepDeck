/**
 * Builds the `PaneInput` a `TerminalPane` registers with the pane-input
 * registry. Kept as a pure, renderer-bound seam so the choice of channel —
 * raw PTY bytes for `write` vs xterm `term.paste` for `paste` — is unit-
 * testable without mounting the component (mounting would require mocking
 * xterm, the canvas addon, and the Tauri IPC sinks). This is the exact seam
 * that fixes the "voice dictation never reached opencode" bug, so a regression
 * that swaps `paste` back onto `writePane` must turn a test red.
 */
import type { PaneInput } from "../../app/paneInput";

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
