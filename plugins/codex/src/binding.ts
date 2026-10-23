import type { AgentBinding } from "@keepdeck/plugin-api";

/**
 * codex's `/new`, told apart from what the deck guards against (task-451).
 *
 * `/new` makes a new thread and no hook; the thread's first prompt fires
 * SessionStart with source `startup` — the same word a second, unrelated
 * session would carry — from the pane's own process (codex 0.163, measured).
 * The deck refuses that as a teammate unless the agent says otherwise.
 *
 * codex has no in-process teammates: its subagents report `SubagentStart`,
 * and a nested `codex exec` is another process the deck refuses on its own.
 * What remains is the rollout's opening `session_meta`, which the session
 * reporter passes along as facts: the pane's own TUI thread is
 * `originator: codex-tui`, `source: cli`, `thread_source: user` — the user
 * started it there. Anything else, or nothing at all, is not the user's new
 * conversation, and the refusal stands.
 *
 * Asked only about a fresh session from the pane's own, already bound
 * process; the process rules stay the deck's.
 */
export const codexBinding: AgentBinding = {
  restartsConversation: ({ source, facts }) =>
    source === "startup" &&
    facts.originator === "codex-tui" &&
    facts.source === "cli" &&
    facts.thread_source === "user",
};
