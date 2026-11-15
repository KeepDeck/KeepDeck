/**
 * What a refused suspend says, in one sentence per reason — shared by the
 * hotkey, the `agent.suspend` command and the close dialog, so the three say
 * the same thing about the same state. The reason is the domain's
 * (`SuspendOutcome`); the words are here.
 */
import type { SuspendOutcome } from "../domain/deck";

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
