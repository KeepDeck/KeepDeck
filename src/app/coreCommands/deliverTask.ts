import { SETTLE_MS, paneInputReady, submitToPane } from "../paneInput";

/**
 * Delivering a spawn's initial task into its pane.
 *
 * Its own module because it is not a registration: `coreCommands/index.ts`
 * registers the core command set, and an exported operation with its own timing
 * constants sitting inside it is the reason that file's job could not be stated
 * in one sentence.
 */

/** How long task delivery waits for the pane's PTY writer to APPEAR — a
 * worktree create plus a CLI start can take a while. Readiness = "the input
 * writer exists" is an MVP heuristic, replaced by a real CLI-ready signal
 * when one exists.
 *
 * How long to wait after that is not decided here: `SETTLE_MS` is the one
 * answer to "the writer exists, but is the CLI READING yet", and this module
 * had its own copy of the same 1500ms with a comment pointing at it. */
const TASK_POLL_MS = 200;
const TASK_POLL_TRIES = 300;

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
  await wait(SETTLE_MS);
  // The PASTE channel with a submit after it — one gesture, owned by
  // `paneInput`. The raw TYPE channel (pane.write mode:"type") inserts
  // printables + LF inline for editable input; it needs LF normalisation,
  // which deliverTask has no reason to take on here.
  return submitToPane(paneIdToWrite, text);
}
