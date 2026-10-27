import { NO_AGENT_MESSAGE } from "../domain/deck";

/** What the dialog's Agent field says in place of a list it cannot offer:
 * nothing while there are agents to pick, a wait while the catalog is still
 * loading, and the way out once it has loaded empty. */
export function agentPickNotice(optionCount: number, loading: boolean): string | null {
  if (optionCount > 0) return null;
  return loading ? "Looking for installed agents…" : NO_AGENT_MESSAGE;
}
