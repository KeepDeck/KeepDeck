/**
 * What a refused suspend says, in one sentence per reason — shared by the
 * hotkey, the `agent.suspend` command and the close dialog, so the three say
 * the same thing about the same state. The reason is the domain's
 * (`SuspendOutcome`); the words are here.
 */
import type { SuspendOutcome, TeamSuspendSkip } from "../domain/deck";

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

/** The subject a team's refusals name, where a single one names the pane. */
const TEAM = "This team";

/** Why a team's Suspend has nobody to take, in one sentence — the reason
 * that holds for the team (which one wins is the menu's call). A reason
 * one pane shares with the team is said in the single sentence. */
export function teamSuspendRefusalText(reason: TeamSuspendSkip): string {
  switch (reason) {
    case "provisioning":
    case "in-flight":
      return suspendRefusalText(reason, TEAM);
    case "remote":
      return "Its running agents run on a remote server — stopping the local client would not park them.";
    case "stopped":
      return "Nothing on this team is running.";
  }
}
