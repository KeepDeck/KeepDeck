import type { Workspace } from "../domain/deck";
import type { AgentInfo } from "../domain/agents";
import type { MemberAnswer, ResumeOutcome } from "../domain/lifecycle";
import { resumeOutcomeText } from "../presentation/resumeWords";
import { membersNotTakenText, paneLabelsIn, UNKNOWN_PANE } from "./memberOutcomes";

/**
 * The one sentence each refusal of "bring this pane back" gets.
 *
 * The words are presentation's (`resumeRefusalText`), shared with the
 * `agent.resume` command. The card used to say nothing at all — it dropped
 * the outcome — so a click that the orchestrator refused looked exactly like
 * a dead button.
 */

/**
 * Ask for a pane back and answer with the sentence to show, or null when it
 * is coming.
 *
 * Here rather than at the surface that renders it: naming the pane means
 * resolving its workspace, its index and its display title — the same three
 * steps `notificationProducers` already takes for a pane-scoped message, and
 * the same shape `useCloseFlow` uses for a refused suspend. A view that does
 * it inline is deriving a domain label mid-render, and it must read the deck
 * BEFORE the request mutates it, which is easy to get wrong in JSX.
 */
export async function askForPaneBack(
  resume: (wsId: string, paneId: string) => Promise<ResumeOutcome>,
  workspaces: Workspace[],
  agents: AgentInfo[],
  wsId: string,
  paneId: string,
): Promise<string | null> {
  const label = paneLabelsIn(workspaces, agents, wsId).get(paneId) ?? UNKNOWN_PANE;
  return resumeOutcomeText(await resume(wsId, paneId), label);
}

/** Ask a team's members back and answer with what to show: a sentence for
 * each member that is not coming — or null when all of them are. */
export async function askForTeamBack(
  resumeTeam: (wsId: string, teamId: string) => Promise<MemberAnswer<ResumeOutcome>[]>,
  workspaces: Workspace[],
  agents: AgentInfo[],
  wsId: string,
  teamId: string,
): Promise<string | null> {
  const labels = paneLabelsIn(workspaces, agents, wsId);
  return membersNotTakenText(await resumeTeam(wsId, teamId), labels, resumeOutcomeText);
}
