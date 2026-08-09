import { paneInputReady, pasteToPane, writeRawToPane } from "../paneInput";

/**
 * Delivering a spawn's initial task into its pane.
 *
 * Its own module because it is not a registration: `coreCommands/index.ts`
 * registers the core command set, and an exported operation with its own timing
 * constants sitting inside it is the reason that file's job could not be stated
 * in one sentence.
 */

/** How long task delivery waits for the pane's PTY writer to appear (a
 * worktree create + CLI start can take a while), then for the CLI to start
 * accepting input. Readiness = "the input writer exists" is an MVP heuristic
 * — replaced by a real CLI-ready signal when one exists. */
const TASK_POLL_MS = 200;
const TASK_POLL_TRIES = 300;
const TASK_SETTLE_MS = 1500;

/** Deliver a spawn's initial task into the pane once its session is live.
 * Fire-and-forget from the spawn handler: the spawn's outcome is the pane,
 * not the task. Returns whether the text was written. */
export async function deliverTask(
  paneIdToWrite: string,
  text: string,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  for (let i = 0; i < TASK_POLL_TRIES && !paneInputReady(paneIdToWrite); i++) {
    await wait(TASK_POLL_MS);
  }
  if (!paneInputReady(paneIdToWrite)) return false;
  await wait(TASK_SETTLE_MS);
  // Deliver the task via the PASTE channel (bracketed framing) — the
  // established auto-submit path. The raw TYPE channel (pane.write
  // mode:"type") inserts printables + LF inline for editable input; it needs
  // LF normalisation, which deliverTask has no reason to take on here.
  if (!pasteToPane(paneIdToWrite, text)) return false;
  // Send the submit Enter as a RAW keystroke AFTER the paste. xterm wraps the
  // WHOLE argument of term.paste in the bracketed-paste markers, so a "\r"
  // concatenated onto the pasted text would arrive as pasted content, not as
  // Enter — the task would sit unsent. A raw CR outside the paste is a real
  // keystroke that submits regardless of the TUI's paste mode.
  writeRawToPane(paneIdToWrite, "\r");
  return true;
}
