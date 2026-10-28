import type { AgentInfo } from "../domain/agents";

/** One refusal as this view reads it. */
interface Refusal {
  agentId: string;
  cwd: string;
  path: string;
  reason: string;
}

/** What the refusals list is titled. */
export const ARM_REFUSALS_TITLE =
  "Some folders kept KeepDeck from setting an agent up — the pane runs without what it was for:";

export interface ArmRefusalLine {
  key: string;
  text: string;
}

/** One line per refusal, the agent named as the catalog names it (its id
 * while no installed plugin provides it), the folder and the path whole: the
 * fix is the user's to make, and it differs — move their own file aside, or
 * the folder is gone, or it could not be written. */
export function armRefusalLines(
  refusals: readonly Refusal[],
  agents: readonly Pick<AgentInfo, "id" | "label">[],
): ArmRefusalLine[] {
  return refusals.map(({ agentId, cwd, path, reason }) => ({
    key: `${agentId}\0${cwd}\0${path}`,
    text: `${agents.find((agent) => agent.id === agentId)?.label ?? agentId}: ${cwd}/${path} — ${reason}`,
  }));
}
