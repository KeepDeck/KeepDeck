/**
 * Whether a keystroke only MOVES — the cursor, or the view — rather than
 * committing anything.
 *
 * The distinction earns its keep because a user at a pane whose agent is
 * waiting on them does exactly two things: read the question back (scroll,
 * arrow around, page up) and then answer it. Only the second is evidence the
 * question is settled, and the agents report no such evidence themselves —
 * see the call site in the status channel for what is done with it.
 *
 * Reads the BYTES a key encodes to rather than the key event, because that
 * is what the terminal actually sends and what the caller already holds;
 * [`keyAction`] owns the separate question of which bytes to send for a key
 * this app overrides.
 */

/**
 * One whole navigation key, and nothing else.
 *
 * Anchored end to end because the caller reports ONE keystroke at a time
 * (xterm's `onKey`, not its data stream): a sequence with anything around it
 * is not a navigation key, and matching loosely would let a stray prefix
 * pass as one.
 *
 * - `\x1b[…A-D`, `\x1bOA-D` — arrows, normal and application-cursor mode.
 *   `[0-9;]*` admits the modified forms (Ctrl+Left is `\x1b[1;5D`).
 * - `\x1b[…H`, `\x1b[…F`, `\x1bOH`, `\x1bOF` — Home and End, both modes.
 * - `\x1b[5~`, `\x1b[6~` and their `;mod` forms — PageUp and PageDown.
 *   Spelled digit by digit: Insert (`2~`) and Delete (`3~`) EDIT, and a
 *   function key is two digits (F5 is `\x1b[15~`), so `[0-9;]*~` would
 *   swallow both classes.
 * - `\x1bb`, `\x1bf` — word-wise motion. xterm rewrites Alt+Left/Alt+Right
 *   to these two ON macOS ONLY (`\x1b[1;5D`/`\x1b[1;5C` elsewhere, which the
 *   arrow branch already covers). Missing them made word motion answer a
 *   prompt on the one platform this app ships.
 *
 * - `\t`, `\x1b[Z` — Tab and Shift+Tab. Not motion in the cursor sense, but
 *   the same ACT: they walk a prompt's options (and cycle claude's
 *   permission modes) without choosing one. Reading them as a commit fails
 *   in the direction that goes silent, so they belong here.
 *
 * Mouse reports and focus events need no branch here: neither reaches a key
 * event.
 */
const NAVIGATION =
  /^(?:\t|\x1b(?:\[(?:[0-9;]*[ABCDHFZ]|[56](?:;[0-9]+)?~)|O[ABCDHF]|[bf]))$/;

/** True when this keystroke only moves around. */
export function isNavigationKey(data: string): boolean {
  return NAVIGATION.test(data);
}
