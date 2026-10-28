import type { AgentType } from "../domain/agents";
import { NO_AGENT_MESSAGE } from "../domain/deck";

/** What the dialog's Agent field shows: words in place of a list it cannot
 * offer, the list with the agent picked, or — for the moment between the
 * catalog arriving and a pick being made — nothing at all, rather than an
 * empty status line. */
export type AgentPickView =
  | { kind: "notice"; text: string }
  | { kind: "pick"; value: AgentType }
  | { kind: "settling" };

/** A wait while the catalog is still loading, the way out once it has loaded
 * empty, and the list once there are agents and one is picked. */
export function agentPickView(
  optionCount: number,
  loading: boolean,
  selected: AgentType | null,
): AgentPickView {
  if (optionCount === 0) {
    return { kind: "notice", text: loading ? "Looking for installed agents…" : NO_AGENT_MESSAGE };
  }
  return selected === null ? { kind: "settling" } : { kind: "pick", value: selected };
}
