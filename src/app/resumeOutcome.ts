import {
  findWorkspace,
  paneDisplayTitle,
  type Workspace,
} from "../domain/deck";
import type { AgentInfo } from "../domain/agents";
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
export function askForPaneBack(
  resume: (wsId: string, paneId: string) => ResumeRequest,
  workspaces: Workspace[],
  agents: AgentInfo[],
  wsId: string,
  paneId: string,
): string | null {
  // The label comes from the deck as it stands NOW — the request below can
  // change it, and the sentence is about the pane the user clicked.
  const ws = findWorkspace(workspaces, wsId);
  const index = ws?.panes.findIndex((pane) => pane.id === paneId) ?? -1;
  const label =
    ws && index >= 0
      ? paneDisplayTitle(ws.panes[index], index, agents)
      : "That agent";
  const outcome = resume(wsId, paneId);
  return outcome === "resuming" ? null : resumeRefusalText(outcome, label);
}

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
