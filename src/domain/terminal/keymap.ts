/**
 * Decides what to do with a terminal key event before xterm encodes it.
 *
 * Generic terminal policy, the same for every agent: the only override is
 * Shift+Enter. Terminals send a bare CR for both Enter and Shift+Enter, so a
 * program can't tell a soft newline from submit. KeepDeck sends the CSI-u
 * sequence `\x1b[13;2u` instead (key 13 = Enter, modifier 2 = Shift; the
 * fixterms / Kitty keyboard encoding), which agent TUIs read as "insert a
 * newline". It's the sequence VSCode's xterm.js sends, accepted without
 * protocol negotiation; every bundled agent was checked live (task-516).
 *
 * Crucially, Shift+Enter must be BLOCKED on every event type (keydown, keypress,
 * keyup) so xterm can't emit a CR from the keypress/keyup that slips past a
 * keydown-only block — but the sequence is sent only once, on keydown. Kept pure
 * so the mapping is testable without xterm/DOM.
 */
export interface KeyEventLike {
  type: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface KeyAction {
  /** Bytes to write to the PTY, or null. */
  send: string | null;
  /** Whether to block xterm's default handling of this event. */
  block: boolean;
}

/** CSI-u encoding for Shift+Enter (Kitty keyboard protocol): ESC [ 13 ; 2 u. */
export const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

export function keyAction(e: KeyEventLike): KeyAction {
  const isShiftEnter =
    e.key === "Enter" &&
    e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey;
  if (isShiftEnter) {
    return {
      send: e.type === "keydown" ? SHIFT_ENTER_SEQUENCE : null,
      block: true,
    };
  }
  return { send: null, block: false };
}
