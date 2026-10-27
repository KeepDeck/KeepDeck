import type { AgentBinding, AgentBindingReport } from "@keepdeck/plugin-api";

/**
 * kimi's `/new`, told apart from what the deck guards against (task-450).
 *
 * `/new` (and `/clear`) fires SessionStart at once with source `startup` —
 * the same word a second, unrelated session would carry — from the pane's own
 * process (Kimi Code 2.3.0, measured). The deck refuses that as a teammate
 * unless the agent says otherwise.
 *
 * In kimi's pane process the only roots that report `startup` are the user's
 * own new sessions — `/new`, `/clear`, the model switch's "new" and the
 * session picker's fallback (2.3.0, measured and read). Subagents report
 * `SubagentStart`; `/fork` reports its root as `resume`, so it never reaches
 * this question. A nested `kimi -p` or `kimi acp` run from the agent's Bash
 * tool or the user's `!` is another process group — kimi spawns that shell
 * detached — and its MCP servers are detached too, so the deck refuses those
 * as foreign-process on its own (measured). So a fresh `startup` from the
 * pane's own, already bound process is the user's new conversation. The
 * residual: a root session made by a child kimi starts in its OWN group, or a
 * future same-process root creator, would be accepted too.
 *
 * Asked only about a fresh session from the pane's own, already bound
 * process; the process rules stay the deck's.
 */
export const kimiBinding = {
  // The one word kimi reports for a continued conversation: `/fork` roots
  // and resumed sessions say `resume`; `/new` and `/clear` say `startup`.
  swapSources: ["resume"],
  restartsConversation: ({ source }: AgentBindingReport) => source === "startup",
} satisfies AgentBinding;
