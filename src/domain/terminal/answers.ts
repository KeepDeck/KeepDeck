/**
 * Whether a chunk of terminal input ANSWERS the question an agent is waiting
 * on.
 *
 * The agents give us no signal for this. Measured on codex 0.146 (and stated
 * outright in claude's own normalizer): a CLI raises its approval prompt as a
 * hook event, and then nothing at all marks the moment the user answers — the
 * next hook is the approved tool's COMPLETION, so the pane keeps claiming
 * "Needs approval" for however long that command runs, which for the commands
 * people actually stop to approve (installs, builds, migrations) is minutes.
 * codex's rollout is no help either: between the ask and the completion it
 * holds nothing.
 *
 * But the answer is a keypress, and the keypress is OURS — every byte that
 * reaches a pane's agent goes through `writePane`. So the host can see the
 * answer the agent never reports. This predicate is the whole rule: input
 * answers, EXCEPT input that only moves around.
 *
 * Navigation is excluded because it is the one thing a user does at a waiting
 * pane that is not an answer — scrolling back to read what is being asked.
 * Clearing the wait there would replace an honest "Needs approval" with a
 * silent "Working" that nothing takes back on codex (unlike claude, whose idle
 * nudge re-raises it), and this codebase's standing rule for that trade-off is
 * `reduceActivity`'s: a flicker is recoverable, silence is not. Arrow keys are
 * also how the dialog's second option is reached, so the arrows themselves
 * decide nothing and the Enter that follows still answers.
 *
 * Deliberately reads BYTES rather than key events: the byte stream is the one
 * place every input path converges, while [`keyAction`] answers the different
 * question of what to send, and duplicating its event handling here would give
 * "what the user pressed" two homes.
 */

/**
 * Cursor motion, paging, mouse reports and focus tracking — the sequences that
 * move a view without committing to anything.
 *
 * `[0-9;]*` covers the modified forms (Ctrl+Arrow arrives as `\x1b[1;5A`), and
 * the tilde forms are spelled one digit at a time on purpose: Home/End/PageUp/
 * PageDown are `1 4 5 6`, while Insert (`2~`) and Delete (`3~`) EDIT and so
 * answer. Writing it as `[0-9;]*~` would swallow the function keys too —
 * F5 is `\x1b[15~`.
 *
 * Mouse comes in both encodings: X10 (`\x1b[M` plus exactly three bytes, which
 * may be any byte at all) and SGR (`\x1b[<0;12;34M`). Focus in/out is `\x1b[I`
 * and `\x1b[O`; a terminal that reports focus must not answer for the user.
 */
const NAVIGATION =
  /\x1b(?:\[(?:[0-9;]*[ABCDHF]|[1456](?:;[0-9]+)?~|M[\s\S]{3}|<[0-9;]*[Mm]|[IO])|O[ABCDHF])/g;

/**
 * True when this input is the user answering. Anything left after the
 * navigation sequences are removed counts — a bare CR, a digit, `y`, Escape,
 * or a pasted block (bracketed-paste markers wrap real text, so a paste keeps
 * its content and answers).
 */
export function answersWait(data: string): boolean {
  return data.replace(NAVIGATION, "").length > 0;
}
