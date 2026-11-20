import {
  findWorkspace,
  paneDisplayTitle,
  type Workspace,
} from "../domain/deck";
import type { AgentInfo } from "../domain/agents";
import type { MemberResumed, ResumeOutcome } from "../domain/lifecycle";
import { resumeOutcomeText } from "../presentation/resumeWords";

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
  // The label comes from the deck as it stands NOW — the request below can
  // change it, and the sentence is about the pane the user clicked.
  const label = labelsIn(workspaces, agents, wsId).get(paneId) ?? UNKNOWN_PANE;
  return resumeOutcomeText(await resume(wsId, paneId), label);
}

/**
 * Ask a team's members back and answer with what to show: one sentence per
 * member that is not coming, a line each — or null when all of them are.
 * Labelled from the deck as it stood before the ask, as a single pane's is.
 */
export async function askForTeamBack(
  resumeTeam: (wsId: string, teamId: string) => Promise<MemberResumed[]>,
  workspaces: Workspace[],
  agents: AgentInfo[],
  wsId: string,
  teamId: string,
): Promise<string | null> {
  const labels = labelsIn(workspaces, agents, wsId);
  const said = (await resumeTeam(wsId, teamId)).flatMap(({ paneId, outcome }) => {
    const text = resumeOutcomeText(outcome, labels.get(paneId) ?? UNKNOWN_PANE);
    return text === null ? [] : [text];
  });
  return said.length === 0 ? null : said.join("\n");
}

const UNKNOWN_PANE = "That agent";

/** Every pane of the workspace by the title the person sees it under. */
function labelsIn(workspaces: Workspace[], agents: AgentInfo[], wsId: string): Map<string, string> {
  const panes = findWorkspace(workspaces, wsId)?.panes ?? [];
  return new Map(panes.map((pane, index) => [pane.id, paneDisplayTitle(pane, index, agents)]));
}
