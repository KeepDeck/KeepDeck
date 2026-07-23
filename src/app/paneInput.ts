/**
 * A tiny registry mapping a pane id to the two ways text can reach its live
 * PTY session:
 *
 *  - `write` — RAW bytes straight into the PTY, in the vein of keyboard
 *    `onData`. Reached via `writeRawToPane` (the name flags it as the niche
 *    raw path). Used by file drag-and-drop (which shapes its own paste
 *    framing around image paths and must not be re-framed) and by voice
 *    dictation via pane.write mode:"type" — printables + LF land inline and
 *    editable; see `writeRawToPane` for the control-byte caveat.
 *  - `paste` — framed paste, routed by the registrant through whatever the
 *    pane's renderer does for a hand paste. Used by spawn task delivery and a
 *    hand ⌘V, so the text reaches the agent as a pasted block; the renderer
 *    (not this registry) decides the framing.
 *
 * One entry per pane: a single `registerPaneInput` call registers both
 * together, so `paneInputReady` (which gates the one entry) is a faithful
 * readiness signal for whichever channel a caller writes through — there is no
 * "the ready channel is not the delivery channel" gap. Each `TerminalPane`
 * registers on mount and removes on unmount. Pane ids are unique across the
 * whole app (one global counter), so there are no collisions.
 */
export interface PaneInput {
  write: (text: string) => void;
  /** Optional: a TYPE-only registrant (e.g. a drag-drop test stub) omits
   * it, and `pasteToPane` then reports the pane as not paste-capable. A live
   * `TerminalPane` always provides both. */
  paste?: (text: string) => void;
}

const entries = new Map<string, PaneInput>();

/** Register a pane's input (both channels); returns an unregister fn for
 * cleanup. */
export function registerPaneInput(
  id: string,
  input: PaneInput,
): () => void {
  entries.set(id, input);
  return () => {
    // Only delete if it's still ours — guards against a re-mount that already
    // replaced the entry (e.g. a StrictMode double-mount).
    if (entries.get(id) === input) entries.delete(id);
  };
}

/** Whether a pane currently has a live input — its terminal is mounted and
 * its session spawned. The task-delivery poll reads this instead of probing
 * with an empty write. */
export function paneInputReady(id: string): boolean {
  return entries.has(id);
}

/** Write text into a pane's session as RAW bytes (TYPE channel — keystroke
 * semantics, no paste framing). Printable bytes and LF (0x0A, a soft newline
 * in every supported agent) land inline and editable; CONTROL bytes are NOT
 * safe — CR (0x0D) submits, and opencode drops the control bytes <32 that
 * are NOT keymap-bound. LF and CR ARE bound (LF→newline, CR→submit), which is
 * exactly why LF is safe to type and CR is not. So a raw caller MUST normalise
 * line endings to LF first (see pane.write mode:"type"). For framed block
 * delivery use `pasteToPane` instead. Returns false if no such pane is live. */
export function writeRawToPane(id: string, text: string): boolean {
  const input = entries.get(id);
  if (!input) return false;
  input.write(text);
  return true;
}

/** Paste text into a pane's session through the renderer's paste path.
 * Returns false if no such pane is live, or if it did not register a paste
 * channel (a TYPE-only pane cannot accept a paste). */
export function pasteToPane(id: string, text: string): boolean {
  const input = entries.get(id);
  if (!input?.paste) return false;
  input.paste(text);
  return true;
}
