import type { AgentBinding } from "@keepdeck/plugin-api";

/**
 * kimi's `/new`, told apart from what the deck guards against (task-450).
 *
 * `/new` (and `/clear`) fires SessionStart at once with source `startup` —
 * the same word a second, unrelated session would carry — from the pane's own
 * process (Kimi Code 2.3.0, measured). The deck refuses that as a teammate
 * unless the agent says otherwise.
 *
 * In kimi's pane process `/new` is the only root-session creator: subagents
 * report `SubagentStart`, `/fork` skips SessionStart, and a nested `kimi` run
 * from a tool call is another process the deck refuses on its own. So a
 * fresh `startup` from the pane's own, already bound process is the user's
 * new conversation. The residual risk is kimi's, not ours to read: a future
 * same-process root creator would be accepted too.
 *
 * Asked only about a fresh session from the pane's own, already bound
 * process; the process rules stay the deck's.
 */
export const kimiBinding: AgentBinding = {
  restartsConversation: ({ source }) => source === "startup",
};
