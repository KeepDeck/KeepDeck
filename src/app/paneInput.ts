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
/** When each pane's input was registered — see [`paneInputSettled`]. */
const registeredAt = new Map<string, number>();
const watchers = new Set<() => void>();

/**
 * How long a freshly registered pane is given before anything is pushed at
 * it unasked.
 *
 * "A writer exists" is not "the CLI reads it". `deliverTask` has always
 * known this and waits out the same kind of gap before its own paste; the
 * number here is that one. Under it, a paste lands in a TUI that is still
 * starting and the submit keystroke after it goes nowhere — the text sits in
 * the composer, unsent, and the deck has no way to tell that from a delivery.
 */
const SETTLE_MS = 1_500;

/**
 * Whether this pane has been writable long enough to be pushed at.
 *
 * Only for text nobody asked for — mail, mostly. A person's own paste or
 * keystroke needs no such gate: they can see the pane, and they are the ones
 * who decided it was ready.
 */
export function paneInputSettled(id: string, now: number = Date.now()): boolean {
  const since = registeredAt.get(id);
  return since !== undefined && now - since >= SETTLE_MS;
}

/**
 * Tell me when any pane's input appears or goes away.
 *
 * The registry is the ONLY thing that knows a pane became writable, and
 * that moment is not visible anywhere else: a terminal mounting emits no
 * status, so anything waiting to write to a pane and watching activity
 * instead would wait for a change that never comes. Mail waited exactly
 * that way, and a task sent to an idle teammate sat undelivered until a
 * person typed into it by hand.
 */
export function subscribePaneInput(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

function announce(): void {
  for (const listener of [...watchers]) listener();
}

/** Register a pane's input (both channels); returns an unregister fn for
 * cleanup. */
export function registerPaneInput(
  id: string,
  input: PaneInput,
): () => void {
  entries.set(id, input);
  registeredAt.set(id, Date.now());
  announce();
  // Becoming SETTLED is a second event, and nothing else would publish it:
  // a caller that was turned away for pushing too early is waiting on a
  // moment no status and no mount reports. Without this it would wait for
  // whatever happened to poke the registry next.
  const settled = setTimeout(announce, SETTLE_MS);
  return () => {
    clearTimeout(settled);
    // Only delete if it's still ours — guards against a re-mount that already
    // replaced the entry (e.g. a StrictMode double-mount).
    if (entries.get(id) === input) {
      entries.delete(id);
      registeredAt.delete(id);
      announce();
    }
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
