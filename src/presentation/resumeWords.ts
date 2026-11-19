/**
 * What a refused "bring this pane back" says, one sentence per reason — the
 * `agent.resume` command and the idle card's Resume / "Look again" buttons
 * say the same thing about the same state. The reason is the domain's
 * (`ResumeRequest`); the words are here.
 */
import type { ResumeRequest, TeamActs } from "../domain/deck";
import { byCount, counted } from "./countWords";

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
    case "archived":
      return `${label} is in an archived workspace — restore the workspace first.`;
    case "gone":
      return `${label} is no longer open.`;
  }
}

/** A team's Resume as every door that asks a team back offers it (its ⋯,
 * its empty grid): named by whom it takes — or null when it would take
 * nobody, and a door has no Resume to offer. One answer, so no two doors
 * can offer or count the same act differently. */
export function teamResumeOffer(resume: Pick<TeamActs["resume"], "take">): string | null {
  const taking = resume.take.length;
  return taking > 0 ? `Resume ${counted(taking, "stopped agent")}` : null;
}

/** Why a team's Resume has nobody to ask back — the reason that holds for
 * the team (which one wins is the menu's call). */
export type TeamResumeRefusal =
  /** A reason every member shares, said as the single Resume says it. */
  | { kind: "archived" | "provisioning" }
  /** Nobody on the team is down. */
  | { kind: "none-stopped" }
  /** Some are down, and every one of them is on a gone folder. */
  | { kind: "folders-gone"; count: number }
  /** Some are down, and none can be brought back — mixed reasons. */
  | { kind: "none-resumable" };

/** The sentence for a team's Resume refusal. */
export function teamResumeRefusalText(refusal: TeamResumeRefusal): string {
  switch (refusal.kind) {
    case "archived":
    case "provisioning":
      return resumeRefusalText(refusal.kind, "This team");
    case "none-stopped":
      return "No agent on this team is stopped.";
    case "folders-gone":
      return `No stopped agent can be resumed — ${byCount(refusal.count, "its folder is gone", "their folders are gone")}.`;
    case "none-resumable":
      return "No stopped agent can be resumed right now.";
  }
}
