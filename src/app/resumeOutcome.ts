import type { ResumeRequest } from "./agentOrchestrator";

/**
 * The one sentence each refusal of "bring this pane back" gets.
 *
 * Its own module for the same reason [`suspendOutcome`] is: the wording is
 * shared by the `agent.resume` command and by the idle card's Resume /
 * "Look again" buttons, and it exists so the two say the same thing about the
 * same state. The card used to say nothing at all — it dropped the outcome —
 * so a click that the orchestrator refused looked exactly like a dead button.
 */

/** One sentence per refusal, so every surface that can ask for a pane back
 * explains a "no" the same way. */
export function resumeRefusalText(
  outcome: Exclude<ResumeRequest, "resuming">,
  label: string,
): string {
  switch (outcome) {
    case "running":
      return `${label} is already running.`;
    case "provisioning":
      return `${label} is still creating its worktree.`;
    case "unavailable":
      return `No installed agent can start ${label}.`;
    case "gone":
      return `${label} is no longer open.`;
  }
}
