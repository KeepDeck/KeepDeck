/**
 * What a refused "bring this pane back" says, one sentence per reason — the
 * `agent.resume` command and the idle card's Resume / "Look again" buttons
 * say the same thing about the same state. The reason is the domain's
 * (`ResumeRequest`); the words are here.
 */
import type { ResumeRequest } from "../domain/deck";

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
