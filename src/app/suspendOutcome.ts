import type { PaneSuspendBlock } from "../domain/deck";

/**
 * What a suspend request did, and the one sentence each answer gets.
 *
 * Its own module rather than a corner of whoever performs the suspend: the
 * wording is shared by the hotkey, the `agent.suspend` command and the close
 * dialog, and it exists precisely so those three say the same thing about the
 * same state. Keeping it beside the machinery would put UI sentences inside
 * the orchestrator, which is the shape this rework is removing.
 */

/** Not a boolean: three surfaces have to explain a refusal, and each one
 * guessing produced a different sentence — one of them false. The reason
 * travels with the answer so they can share the words. */
export type SuspendOutcome =
  | "suspended"
  | PaneSuspendBlock
  /** A suspend for this pane is already reaping its process. */
  | "in-flight"
  /** The pane (or its workspace) is no longer in the deck. */
  | "gone";

/** One sentence per refusal, so the hotkey, the command and any later surface
 * say the same thing about the same state. */
export function suspendRefusalText(
  outcome: Exclude<SuspendOutcome, "suspended">,
  label: string,
): string {
  switch (outcome) {
    case "stopped":
      return `${label} is already stopped.`;
    case "provisioning":
      return `${label} is still creating its worktree.`;
    case "remote":
      return `${label} runs on a remote server — its session lives there, so stopping the local client would not park it.`;
    case "in-flight":
      return `${label} is already being suspended.`;
    case "gone":
      return `${label} is no longer open.`;
  }
}
