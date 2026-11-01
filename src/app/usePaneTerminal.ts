import { notePaneInputWritten, registerPaneInput, type PaneInput } from "./paneInput";
import { reportPaneKey } from "./paneKeys";
import { attachPane, isPaneLaunched, resizePane, writePane, type PaneSink } from "./ptyManager";

/**
 * What a terminal view needs of its pane: the PTY it shows (attach, write,
 * resize), whether that PTY is up yet, and the two lanes it feeds back —
 * the input a voice or task delivery writes through, and the keys a person
 * types (the answer lane).
 */
export interface PaneTerminalPort {
  isLaunched(paneId: string): boolean;
  /** Stream the pane's output into `sink` until the returned detach. */
  attach(paneId: string, sink: PaneSink): () => void;
  write(paneId: string, data: string): void;
  resize(paneId: string, cols: number, rows: number): void;
  /** Make `input` the pane's delivery channel until the returned disposer. */
  registerInput(paneId: string, input: PaneInput): () => void;
  reportKey(paneId: string, key: string): void;
  /** A person pasted into this pane — ⌘V or the Edit menu, which reach the
   * terminal as a paste and never as keys. Words in the composer all the
   * same, and a line typed after them would be sent with them. */
  reportPaste(paneId: string): void;
}

const port: PaneTerminalPort = {
  isLaunched: (paneId) => isPaneLaunched(paneId),
  attach: (paneId, sink) => attachPane(paneId, sink),
  write: (paneId, data) => writePane(paneId, data),
  resize: (paneId, cols, rows) => resizePane(paneId, cols, rows),
  registerInput: (paneId, input) => registerPaneInput(paneId, input),
  reportKey: (paneId, key) => reportPaneKey(paneId, key),
  reportPaste: (paneId) => notePaneInputWritten(paneId),
};

/** The pane terminal port. Stable across renders. */
export function usePaneTerminal(): PaneTerminalPort {
  return port;
}

export type { PaneInput, PaneSink };
